import express from 'express';
import * as http from 'node:http';
import * as https from 'node:https';
import { URL } from 'url';

const app = express();
app.use(express.raw({ type: '*/*' })); // Đảm bảo req.body là Buffer

app.all('/', async (req, res) => {
    const targetParams = parseTargetParameters(req);
    if (!targetParams.url) {
        res.status(400).send("query parameter 'url' is required");
        return;
    }

    const targetReqUrl = targetParams.url;

    // === Chuẩn hóa lại headers ===
    const headers = { ...req.headers };
    // Xóa các header không nên forward
    delete headers.host;
    delete headers['content-length'];
    delete headers.connection;

    // Loại trừ các header bắt đầu bằng x-vercel-
    Object.keys(headers).forEach((k) => {
        if (k.toLowerCase().startsWith('x-vercel-')) delete headers[k];
    });

    // Nếu có x-auth-token thì chuyển thành Cookie
    if (headers['x-auth-token']) {
        headers['cookie'] = `WorkstationJwtPartitioned=${headers['x-auth-token']}`;
        delete headers['x-auth-token'];
    }

    // === Tạo request tới backend ===
    const options = {
        protocol: targetReqUrl.protocol,
        hostname: targetReqUrl.hostname,
        port: targetReqUrl.port || (targetReqUrl.protocol === 'https:' ? 443 : 80),
        path: targetReqUrl.pathname + targetReqUrl.search,
        method: req.method,
        headers: headers,
    };

    const httpModule = targetReqUrl.protocol === 'https:' ? https : http;
    const targetReq = httpModule.request(options, (targetRes) => {
        // Set status code
        res.status(targetRes.statusCode);

        // Copy tất cả headers từ backend, ngoại trừ các header gây lỗi CORS
        Object.entries(targetRes.headers).forEach(([key, value]) => {
            if (![
                'content-security-policy',
                'content-security-policy-report-only',
                'cross-origin-resource-policy',
                'reporting-endpoints',
                'report-to'
            ].includes(key.toLowerCase())
            ) {
                res.setHeader(key, value);
            }
        });

        // Set lại CORS headers
        res.setHeader('access-control-allow-origin', '*');
        res.setHeader('access-control-allow-methods', 'GET,POST,PUT,DELETE,OPTIONS');

        // Pipe data từ backend về client
        targetRes.on('data', (chunk) => res.write(chunk));
        targetRes.on('end', () => res.end());
        targetRes.on('error', (err) => res.destroy(err));
    });

    targetReq.on('error', (err) => {
        res.status(500).json({ error: "Proxy error", details: err.message });
    });

    // Gửi body nếu có (POST, PUT,...)
    if (req.body && req.body.length > 0 && req.method !== "GET" && req.method !== "HEAD") {
        targetReq.write(req.body);
    }
    targetReq.end();
});

function request(url, options = {}, callback) {
    const httpModule = url.protocol === 'https:' ? https : http;
    return httpModule.request(url, options, callback);
}

function parseTargetParameters(proxyRequest) {
    const params = {}
    // url - treat everything right to url= query parameter as target url value
    const urlMatch = proxyRequest.url.match(/(?<=[?&])url=(?<url>.*)$/);
    if (urlMatch) {
        params.url = new URL(decodeURIComponent(urlMatch.groups.url));
    }
    return params;
}

export default app;
