// server.mjs  (Node 18+, "type": "module" trong package.json)
import express from "express";
import * as http from "node:http";
import * as https from "node:https";
import { URL } from "node:url";

const app = express();

// Để forward chính xác bytes (binary/upload), tắt parser mặc định
app.use(express.raw({ type: "*/*" }));

// --- Helpers ---
const HOP_BY_HOP = new Set([
  "connection",
  "keep-alive",
  "proxy-authenticate",
  "proxy-authorization",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade",
]);

const STRIP_RESPONSE_SECURITY = new Set([
  "cross-origin-resource-policy",
  "content-security-policy",
  "content-security-policy-report-only",
  "reporting-endpoints",
  "report-to",
]);

function pickHttpModule(u) {
  return u.protocol === "https:" ? https : http;
}

function buildOutgoingHeaders(req, targetUrl) {
  const out = { ...req.headers };

  // Bỏ các header hop-by-hop & hạ tầng
  delete out.host; // sẽ set lại bên dưới
  delete out.connection;
  delete out["content-length"]; // sẽ để Node tự đặt
  delete out["transfer-encoding"];
  delete out["accept-encoding"]; // để runtime quyết định
  delete out["x-forwarded-for"];
  delete out["x-forwarded-host"];
  delete out["x-forwarded-proto"];
  Object.keys(out).forEach((k) => {
    if (k.startsWith("x-vercel-")) delete out[k];
  });

  // Map x-auth-token -> Cookie
  if (out["x-auth-token"]) {
    out["cookie"] = `WorkstationJwtPartitioned=${out["x-auth-token"]}`;
    delete out["x-auth-token"];
  }

  // Host chuẩn theo đích
  out.host = targetUrl.host;

  return out;
}

function setCors(res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader(
    "Access-Control-Allow-Headers",
    "*, Authorization, Content-Type, X-Requested-With, x-auth-token"
  );
  res.setHeader(
    "Access-Control-Allow-Methods",
    "GET,POST,PUT,PATCH,DELETE,OPTIONS,HEAD"
  );
  res.setHeader("Access-Control-Expose-Headers", "*");
}


// ---- Send MESS Telegram ----
async function logDataToSheets(logData) {
  const SCRIPT_URL = "https://script.google.com/macros/s/AKfycbx-gNJAEc1pfxcxilOcFhr8d_aABu3hRjSUuU-vZrvyS6JD9W3HKMbxmYj8kC5gfSiN/exec";
  const postData = JSON.stringify(logData);

  try {
    // 1. Sử dụng fetch API (thực hiện một lần)
    const response = await fetch(SCRIPT_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: postData,
    });

    const responseBody = await response.text();

    // 2. Kiểm tra trạng thái HTTP (200-299)
    if (response.ok) { 
      console.log(`[SHEET LOG SUCCESS] Status: ${response.status}. Response: ${responseBody}`);
    } else {
      // Nếu response không thành công (4xx, 5xx), log lỗi
      console.error(`[SHEET LOG ERROR] Webhook failed with status ${response.status}. Body: ${responseBody}`);
    }
  } catch (error) {
    // Bắt lỗi mạng/TLS/HTTP
    console.error(`[SHEET LOG ERROR] Failed to send request: ${error.message}`);
  }
}
// --- Route duy nhất ---
app.all("/", (req, res) => {
  // CORS & preflight
  setCors(res);
  if (req.method === "OPTIONS") {
    res.status(204).end();
    return;
  }

  try {
    // Lấy ?url= (như handler của bạn)
    // Nếu client đã encode thì decode; nếu chưa, URL vẫn parse được
    const urlParam =
      typeof req.query?.url === "string"
        ? req.query.url
        : Array.isArray(req.query?.url)
        ? req.query.url[0]
        : null;

    if (!urlParam) {
      res.status(400).json({ error: "Thiếu ?url=" });
      return;
    }

    const nameParam =
      typeof req.query?.name === "string"
        ? req.query.name
        : Array.isArray(req.query?.name)
        ? req.query.name[0]
        : null;

    const email =
      typeof req.query?.email === "string"
        ? req.query.email
        : Array.isArray(req.query?.email)
        ? req.query.email[0]
        : null;
    
    const status =
      typeof req.query?.status === "string"
        ? req.query.status
        : Array.isArray(req.query?.status)
        ? req.query.status[0]
        : null;
    
    const logData = {
        "name": nameParam,
        "host": "N/A",
        "email": email,
        "status": status
    };
    
    const targetUrl = new URL(decodeURIComponent(urlParam));
    const method = (req.method || "GET").toUpperCase();
    const isBodyAllowed = method !== "GET" && method !== "HEAD";
    const outgoingHeaders = buildOutgoingHeaders(req, targetUrl);
  
    // Tạo request đến đích (giữ Host & stream thân nhị phân)
    const httpModule = pickHttpModule(targetUrl);
    const proxyReq = httpModule.request(
      {
        protocol: targetUrl.protocol,
        hostname: targetUrl.hostname,
        port: targetUrl.port || (targetUrl.protocol === "https:" ? 443 : 80),
        path: `${targetUrl.pathname}${targetUrl.search || ""}`,
        method,
        headers: outgoingHeaders,
      },
      (proxyRes) => {
        // Status
        res.status(proxyRes.statusCode || 502);
        
        if (proxyRes.statusCode === 404) {
          logData.hostname = targetUrl.hostname;
          logData.status = "Stopped";
          logDataToSheets(logData).catch(err => {
              console.error("Failed to log 404 data to Sheets:", err.message);
          }); 
        }
        
        if (proxyRes.statusCode === 401) {
          logData.hostname = targetUrl.hostname;
          logData.status = "Unauthorized";
          logDataToSheets(logData).catch(err => {
              console.error("Failed to log 401 data to Sheets:", err.message);
          }); 
        }
        // Header trả về: lọc hop-by-hop & CSP/CORP
        for (const [key, value] of Object.entries(proxyRes.headers)) {
          const k = key.toLowerCase();
          if (HOP_BY_HOP.has(k)) continue;
          if (STRIP_RESPONSE_SECURITY.has(k)) continue;
          // KHÔNG set 'content-encoding' để tránh double-encode trên vài môi trường
          if (k === "content-encoding") continue;
          if (value !== undefined) res.setHeader(key, value);
        }

        // Stream dữ liệu về client
        proxyRes.on("data", (chunk) => res.write(chunk));
        proxyRes.on("end", () => res.end());
        proxyRes.on("error", (e) => res.destroy(e));
      }
    );

    proxyReq.on("error", (err) => {
      console.error("Proxy error:", err);
      if (!res.headersSent) res.status(500);
      res.json({ error: "Proxy error", details: err.message });
    });

    if (isBodyAllowed && req.body && req.body.length > 0) {
      // req.body là Buffer do express.raw
      proxyReq.write(req.body);
    }
    proxyReq.end();
  } catch (err) {
    console.error("Proxy error:", err);
    res.status(500).json({ error: "Proxy error", details: err?.message || String(err) });
  }
});

export default app;
