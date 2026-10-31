// 测试辅助：脚本化的假 SSTP 服务端（HTTP/LCP/IPCP/TCP 握手后由测试推包）
export const u16 = (n) => [(n >> 8) & 0xff, n & 0xff];
export const u32 = (n) => [(n >>> 24) & 0xff, (n >>> 16) & 0xff, (n >>> 8) & 0xff, n & 0xff];
export const sstpData = (ppp) => new Uint8Array([0x10, 0x00, ...u16((6 + ppp.length) | 0x8000), 0xff, 0x03, ...ppp]);
export const sstpCtrl = (type) => new Uint8Array([0x10, 0x01, 0x80, 0x08, ...u16(type), 0x00, 0x00]);
export const pppCtl = (proto, code, id, opts = []) => [...u16(proto), code, id, ...u16(4 + opts.length), ...opts];
export const CLIENT_IP = [10, 0, 0, 2];
export const TARGET_IP = [1, 2, 3, 4];

export function ipTcp({ sport, dport, seq, ack = 0, flags, payload = [], win = 65535 }) {
  const tcp = [...u16(sport), ...u16(dport), ...u32(seq), ...u32(ack), 0x50, flags, ...u16(win), 0, 0, 0, 0, ...payload];
  const ip = [0x45, 0, ...u16(20 + tcp.length), 0, 0, 0x40, 0, 64, 6, 0, 0, ...TARGET_IP, ...CLIENT_IP];
  return [0x00, 0x21, ...ip, ...tcp];
}

/** 假 SSTP 服务端：完成 HTTP/LCP/IPCP/TCP 握手，之后由测试脚本推送数据包，并记录客户端写出的所有字节 */
export function fakeServer() {
  let push;
  const writes = [];
  const waiters = [];
  const state = { clientPort: 0, serverSeq: 1000, synSeen: false };
  const readable = new ReadableStream({ start(c) { push = (b) => c.enqueue(b); } });
  const onWrite = (b) => {
    writes.push(b);
    if (b[0] === 0x53) { // "SSTP_DUPLEX_POST ..."：HTTP 200 + 服务端 LCP 请求 + 确认客户端 LCP
      push(new TextEncoder().encode('HTTP/1.1 200 OK\r\n\r\n'));
      push(sstpData(pppCtl(0xc021, 1, 1)));
      push(sstpData(pppCtl(0xc021, 2, 1, [1, 4, 0x05, 0xdc])));
      return;
    }
    // SSTP 数据包里的 PPP 协议号在偏移 6
    const proto = (b[6] << 8) | b[7];
    if (proto === 0x8021 && b[8] === 1) {
      const addr = [...b.subarray(14, 18)];
      if (addr.every((x) => x === 0)) push(sstpData(pppCtl(0x8021, 3, b[9], [3, 6, ...CLIENT_IP])));
      else push(sstpData(pppCtl(0x8021, 2, b[9], [3, 6, ...CLIENT_IP])));
      return;
    }
    if (proto === 0x0021 && !state.synSeen && b[41] === 0x02) {
      state.synSeen = true;
      state.clientPort = (b[28] << 8) | b[29];
      push(sstpData(ipTcp({ sport: 80, dport: state.clientPort, seq: state.serverSeq, flags: 0x12 })));
      state.serverSeq++;
    }
    for (const w of waiters.splice(0)) w();
  };
  const writable = new WritableStream({ write(chunk) { onWrite(new Uint8Array(chunk)); } });
  const socket = { opened: Promise.resolve(), readable, writable, closed: new Promise(() => {}), close() {} };
  const connector = () => socket;
  const waitWrite = (pred, ms = 2000) => new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error('等待客户端写出超时')), ms);
    const check = () => { const hit = writes.find(pred); if (hit) { clearTimeout(t); resolve(hit); } else waiters.push(check); };
    check();
  });
  return { push, writes, state, connector, waitWrite };
}
