// 代理检查（后台 /admin/check）：逐行移植自上游 cmliu/edgetunnel _worker.js 138–206 行（GPL-2.0）。
// 通过指定的 SOCKS5/HTTP/HTTPS/TURN/SSTP 代理向 cloudflare.com 发起 TLS 请求 /cdn-cgi/trace，返回出口 IP 与地区。
import {
  parseChainAccount, defaultChainPort, createTcpConnector, socks5Connect, turnConnect, sstpConnect,
  httpConnect, httpsConnect, isIPHostname, TlsClient, concatBytes,
} from './edt-core.js';

export const CHECK_PROTOCOLS = ['socks5', 'http', 'https', 'turn', 'sstp'];

/**
 * @param {Request} request 当前请求（需 request.fetcher.connect 可用）
 * @param {string} protocol socks5|http|https|turn|sstp
 * @param {string} param 代理参数（user:pass@host:port 等，同上游）
 */
export async function checkProxy(request, protocol, param) {
  const startTime = Date.now();
  let full = param;
  try {
    const parsed = await parseChainAccount(param, defaultChainPort(protocol));
    const { username, password, hostname, port } = parsed;
    full = username && password ? `${username}:${password}@${hostname}:${port}` : `${hostname}:${port}`;
    try {
      const host = 'cloudflare.com', hostPort = 443, encoder = new TextEncoder(), decoder = new TextDecoder();
      const connect = createTcpConnector(request);
      let tcpSocket = null, tlsSocket = null;
      try {
        tcpSocket = protocol === 'socks5'
          ? await socks5Connect(host, hostPort, new Uint8Array(0), connect, parsed)
          : protocol === 'turn'
            ? await turnConnect(parsed, host, hostPort, connect)
            : protocol === 'sstp'
              ? await sstpConnect(parsed, host, hostPort, connect)
              : (protocol === 'https' && isIPHostname(hostname)
                ? await httpsConnect(host, hostPort, new Uint8Array(0), connect, parsed)
                : await httpConnect(host, hostPort, new Uint8Array(0), protocol === 'https', connect, parsed));
        if (!tcpSocket) throw new Error('无法连接到代理服务器');
        tlsSocket = new TlsClient(tcpSocket, { serverName: host, insecure: true });
        await tlsSocket.handshake();
        await tlsSocket.write(encoder.encode(`GET /cdn-cgi/trace HTTP/1.1\r\nHost: ${host}\r\nUser-Agent: Mozilla/5.0\r\nConnection: close\r\n\r\n`));
        let buf = new Uint8Array(0), headerEnd = -1, contentLength = null, chunked = false;
        const maxBytes = 64 * 1024;
        while (buf.length < maxBytes) {
          const value = await tlsSocket.read();
          if (!value) break;
          if (value.byteLength === 0) continue;
          buf = concatBytes(buf, value);
          if (headerEnd === -1) {
            const idx = buf.findIndex((_, i) => i < buf.length - 3 && buf[i] === 0x0d && buf[i + 1] === 0x0a && buf[i + 2] === 0x0d && buf[i + 3] === 0x0a);
            if (idx !== -1) {
              headerEnd = idx + 4;
              const headers = decoder.decode(buf.slice(0, headerEnd));
              const statusLine = headers.split('\r\n')[0] || '';
              const m = statusLine.match(/HTTP\/\d\.\d\s+(\d+)/);
              const code = m ? parseInt(m[1], 10) : NaN;
              if (!Number.isFinite(code) || code < 200 || code >= 300) throw new Error(`代理检测请求失败: ${statusLine || '无效响应'}`);
              const lm = headers.match(/\r\nContent-Length:\s*(\d+)/i);
              if (lm) contentLength = parseInt(lm[1], 10);
              chunked = /\r\nTransfer-Encoding:\s*chunked/i.test(headers);
            }
          }
          if (headerEnd !== -1 && contentLength !== null && buf.length >= headerEnd + contentLength) break;
          if (headerEnd !== -1 && chunked && decoder.decode(buf).includes('\r\n0\r\n\r\n')) break;
        }
        if (headerEnd === -1) throw new Error('代理检测响应头过长或无效');
        const text = decoder.decode(buf);
        const ip = text.match(/(?:^|\n)ip=(.*)/)?.[1];
        const loc = text.match(/(?:^|\n)loc=(.*)/)?.[1];
        if (!ip || !loc) throw new Error('代理检测响应无效');
        return { success: true, proxy: protocol + '://' + full, ip, loc, responseTime: Date.now() - startTime };
      } finally {
        try { tlsSocket ? tlsSocket.close() : await tcpSocket?.close?.(); } catch { /* 忽略 */ }
      }
    } catch (error) {
      return { success: false, error: error.message, proxy: protocol + '://' + full, responseTime: Date.now() - startTime };
    }
  } catch (err) {
    return { success: false, error: err.message, proxy: protocol + '://' + param, responseTime: Date.now() - startTime };
  }
}
