import express from 'express';
import * as http from 'node:http';
import * as https from 'node:https';
import { URL } from 'url';
import cors from "cors";

const app = express();
app.use(express.raw({ type: '*/*' })); // Đảm bảo req.body là Buffer
app.use(cors());
// Cho phép preflight (OPTIONS)
app.options("*", cors());

// Agent SSL (nếu backend có cert không chuẩn → bỏ check SSL)
const httpsAgent = new https.Agent({
  rejectUnauthorized: false
});


app.all('/', async (req, res) => {
    try {
    const targetUrl = req.query.url;
    if (!targetUrl) {
      return res.status(400).json({ error: "Thiếu ?url=" });
    }

    // Copy headers gốc từ browser
    const headers = { ...req.headers };
    delete headers.host;
    delete headers["content-length"];
    delete headers.connection;

    // ✅ Nếu browser gửi X-Auth-Token → đổi thành Cookie
    if (headers["x-auth-token"]) {
      headers["cookie"] = `WorkstationJwtPartitioned=${headers["x-auth-token"]}`;
      delete headers["x-auth-token"];
    }

    // Forward request tới backend
    const response = await fetch(targetUrl, {
      method: req.method,
      headers,
      body: req.method !== "GET" && req.method !== "HEAD"
        ? JSON.stringify(req.body)
        : undefined,
      agent: httpsAgent
    });

    // Forward lại status + headers + body
    res.status(response.status);
    response.headers.forEach((value, key) => {
      res.setHeader(key, value);
    });

    const buffer = await response.buffer();
    res.send(buffer);

  } catch (err) {
    console.error("Proxy error:", err);
    res.status(500).json({ error: "Proxy error", details: err.message });
  }
});

// function request(url, options = {}, callback) {
//     const httpModule = url.protocol === 'https:' ? https : http;
//     return httpModule.request(url, options, callback);
// }

// function parseTargetParameters(proxyRequest) {
//     const params = {}
//     // url - treat everything right to url= query parameter as target url value
//     const urlMatch = proxyRequest.url.match(/(?<=[?&])url=(?<url>.*)$/);
//     if (urlMatch) {
//         params.url = new URL(decodeURIComponent(urlMatch.groups.url));
//     }
//     return params;
// }

export default app;
