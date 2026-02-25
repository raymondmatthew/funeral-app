/**
 * Route at /apps/engraving/upload.
 */
import { authenticate, unauthenticated } from "./shopify.server";

const MAX_FILE_SIZE = 5 * 1024 * 1024; // 5 MB

// Magic bytes for allowed image types (PNG, JPEG, GIF)
const PNG_SIG = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
const JPEG_SIG = [0xff, 0xd8, 0xff];
const GIF87_SIG = [0x47, 0x49, 0x46, 0x38, 0x37, 0x61];
const GIF89_SIG = [0x47, 0x49, 0x46, 0x38, 0x39, 0x61];

function bytesMatch(buf, offset, sig) {
  for (let i = 0; i < sig.length; i++) {
    if (buf[offset + i] !== sig[i]) return false;
  }
  return true;
}

async function isAllowedImage(blob) {
  if (blob.size > MAX_FILE_SIZE) return { ok: false, error: "File too large (max 5 MB)" };
  const buf = new Uint8Array(await blob.slice(0, 12).arrayBuffer());
  if (bytesMatch(buf, 0, PNG_SIG)) return { ok: true, mime: "image/png", ext: "png" };
  if (bytesMatch(buf, 0, JPEG_SIG)) return { ok: true, mime: "image/jpeg", ext: "jpg" };
  if (bytesMatch(buf, 0, GIF87_SIG) || bytesMatch(buf, 0, GIF89_SIG)) return { ok: true, mime: "image/gif", ext: "gif" };
  return { ok: false, error: "Invalid image. Only PNG, JPEG, and GIF are allowed." };
}

const corsHeaders = (request) => {
  const origin = request.headers.get("Origin");
  return {
    "Content-Type": "application/json",
    "Access-Control-Allow-Origin": origin || "*",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, X-Engraving-Direct-Secret, X-Shop-Domain",
  };
};

export function jsonResponse(data, status = 200, request = null) {
  const headers = request ? corsHeaders(request) : { "Content-Type": "application/json" };
  return new Response(JSON.stringify(data), { status, headers });
}

export const loader = async ({ request }) => {
  if (request.method === "OPTIONS") {
    return new Response(null, { status: 204, headers: corsHeaders(request) });
  }
  return jsonResponse(
    { error: "Method not allowed. Use POST with form field 'file'." },
    405,
    request
  );
};

export const action = async ({ request }) => {
  if (request.method === "OPTIONS") {
    return new Response(null, { status: 204, headers: corsHeaders(request) });
  }
  if (request.method !== "POST") {
    return jsonResponse({ error: "Method not allowed" }, 405, request);
  }

  const formData = await request.formData();
  const file = formData.get("file");
  let admin;
  try {
    const context = await authenticate.public.appProxy(request);
    admin = context.admin;
  } catch {
    admin = null;
  }
  if (!admin) {
    const directSecret = process.env.ENGRAVING_DIRECT_UPLOAD_SECRET;
    const secretHeader = request.headers.get("X-Engraving-Direct-Secret");
    const shopHeader = request.headers.get("X-Shop-Domain");
    const shopForm = formData.get("shop");
    const shop = (typeof shopForm === "string" ? shopForm : null) || shopHeader;
    if (directSecret && secretHeader === directSecret && shop) {
      try {
        const direct = await unauthenticated.admin(shop);
        admin = direct.admin;
      } catch {
        admin = null;
      }
    }
  }
  if (!admin) {
    return jsonResponse(
      { error: "Unauthorized. Use app proxy or send X-Engraving-Direct-Secret and X-Shop-Domain." },
      401,
      request
    );
  }
  if (!file || !(file instanceof Blob) || file.size === 0) {
    return jsonResponse({ error: "Missing or empty file" }, 400, request);
  }

  const validation = await isAllowedImage(file);
  if (!validation.ok) {
    return jsonResponse({ error: validation.error }, 400, request);
  }

  const filename = `engraving-preview.${validation.ext}`;
  const mimeType = validation.mime;

  try {
    const stagedResponse = await admin.graphql(
      `#graphql
      mutation stagedUploadsCreate($input: [StagedUploadInput!]!) {
        stagedUploadsCreate(input: $input) {
          stagedTargets {
            url
            resourceUrl
            parameters { name value }
          }
          userErrors { field message }
        }
      }`,
      {
        variables: {
          input: [
            {
              filename,
              mimeType,
              resource: "PRODUCT_IMAGE",
              httpMethod: "POST",
            },
          ],
        },
      }
    );
    const stagedJson = await stagedResponse.json();
    const staged = stagedJson?.data?.stagedUploadsCreate;
    const userErrors = staged?.userErrors || [];
    if (userErrors.length > 0) {
      return jsonResponse(
        { error: userErrors.map((e) => e.message).join(", ") },
        400,
        request
      );
    }
    const target = staged?.stagedTargets?.[0];
    if (!target?.url || !target?.resourceUrl) {
      return jsonResponse(
        { error: "Staged upload target missing" },
        500,
        request
      );
    }

    const uploadForm = new FormData();
    for (const p of target.parameters || []) {
      uploadForm.append(p.name, p.value);
    }
    uploadForm.append("file", file, filename);

    const uploadRes = await fetch(target.url, {
      method: "POST",
      body: uploadForm,
    });
    if (!uploadRes.ok) {
      return jsonResponse(
        { error: `Upload failed: ${uploadRes.statusText}` },
        502,
        request
      );
    }

    const fileCreateResponse = await admin.graphql(
      `#graphql
      mutation fileCreate($files: [FileCreateInput!]!) {
        fileCreate(files: $files) {
          files {
            id
            fileStatus
            ... on MediaImage { image { url } }
            ... on GenericFile { url }
          }
          userErrors { field message code }
        }
      }`,
      {
        variables: {
          files: [
            {
              contentType: "IMAGE",
              originalSource: target.resourceUrl,
              alt: "Engraving preview",
            },
          ],
        },
      }
    );
    const fileCreateJson = await fileCreateResponse.json();
    const fc = fileCreateJson?.data?.fileCreate;
    const fcErrors = fc?.userErrors || [];
    if (fcErrors.length > 0) {
      return jsonResponse(
        { error: fcErrors.map((e) => e.message).join(", ") },
        400,
        request
      );
    }
    const created = fc?.files?.[0];
    let url = created?.image?.url ?? created?.url ?? null;
    const fileId = created?.id ?? null;

    if (!url && fileId) {
      const maxAttempts = 15;
      const delayMs = 1000;
      for (let attempt = 1; attempt <= maxAttempts; attempt++) {
        await new Promise((r) => setTimeout(r, delayMs));
        const pollResponse = await admin.graphql(
          `#graphql
          query getFile($id: ID!) {
            node(id: $id) {
              ... on MediaImage {
                fileStatus
                image { url }
              }
            }
          }`,
          { variables: { id: fileId } }
        );
        const pollJson = await pollResponse.json();
        const node = pollJson?.data?.node;
        url = node?.image?.url ?? null;
        if (url) break;
        if (node?.fileStatus === "FAILED") {
          return jsonResponse(
            { error: "File processing failed" },
            502,
            request
          );
        }
      }
    }

    if (!url) {
      return jsonResponse(
        {
          error: "File created but URL not ready yet",
          image_url: null,
          file_url: null,
        },
        200,
        request
      );
    }
    return jsonResponse({ url, image_url: url, file_url: url }, 200, request);
  } catch (err) {
    console.error("[engraving/upload]", err);
    return jsonResponse(
      { error: err?.message || "Upload failed" },
      500,
      request
    );
  }
};
