//! 极简 HTTP/1.1 客户端，只服务本项目的局域网收发，不是通用实现。
//!
//! 为什么不用 ureq：`send(&File)` 由库内部写盘，拿不到发送进度，
//! 而进度条是传输视图的硬需求；协议又只有 Content-Length 一种形态，
//! 手写约 100 行换来零依赖与完全可控（设计文档风险 #7 预留的回退）。

use std::io::{BufRead, BufReader, Read, Write};
use std::net::{TcpStream, ToSocketAddrs};
use std::time::Duration;

pub struct Reply {
    pub status: u16,
    pub body: Vec<u8>,
}

impl Reply {
    pub fn ok(&self) -> bool {
        (200..300).contains(&self.status)
    }

    pub fn body_str(&self) -> String {
        String::from_utf8_lossy(&self.body).to_string()
    }
}

fn connect(host: &str, port: u16, timeout: Duration) -> Result<TcpStream, String> {
    let addr = (host, port)
        .to_socket_addrs()
        .map_err(|e| format!("解析地址 {host}:{port} 失败: {e}"))?
        .next()
        .ok_or_else(|| format!("{host}:{port} 没有可用地址"))?;
    TcpStream::connect_timeout(&addr, timeout).map_err(|e| format!("连接 {host}:{port} 失败: {e}"))
}

fn write_head(
    stream: &mut TcpStream,
    method: &str,
    path: &str,
    headers: &[(String, String)],
    content_len: u64,
) -> Result<(), String> {
    let mut head = format!("{method} {path} HTTP/1.1\r\nConnection: close\r\n");
    for (k, v) in headers {
        // 头部值里出现换行会破坏协议，非 ASCII 会被对端 tiny_http 直接丢掉，
        // 两种都报错而不是默默发出去（中文文件名要走 store::hdr_encode）
        if v.contains('\n') || v.contains('\r') {
            return Err(format!("请求头 {k} 含非法换行"));
        }
        if !v.is_ascii() {
            return Err(format!("请求头 {k} 含非 ASCII 内容，需要先编码"));
        }
        head.push_str(&format!("{k}: {v}\r\n"));
    }
    head.push_str(&format!("Content-Length: {content_len}\r\n\r\n"));
    stream
        .write_all(head.as_bytes())
        .map_err(|e| format!("发送请求头失败: {e}"))
}

fn read_reply(stream: &mut TcpStream) -> Result<Reply, String> {
    let mut reader = BufReader::new(stream.try_clone().map_err(|e| format!("复制流失败: {e}"))?);
    let mut status_line = String::new();
    reader
        .read_line(&mut status_line)
        .map_err(|e| format!("读状态行失败: {e}"))?;
    let status = status_line
        .split_whitespace()
        .nth(1)
        .and_then(|s| s.parse::<u16>().ok())
        .ok_or_else(|| format!("响应状态行非法: {status_line:?}"))?;

    let mut content_len: Option<usize> = None;
    loop {
        let mut line = String::new();
        let n = reader
            .read_line(&mut line)
            .map_err(|e| format!("读响应头失败: {e}"))?;
        if n == 0 {
            break;
        }
        let trimmed = line.trim_end();
        if trimmed.is_empty() {
            break;
        }
        if let Some(v) = trimmed.strip_prefix("Content-Length:").or_else(|| trimmed.strip_prefix("content-length:")) {
            content_len = v.trim().parse::<usize>().ok();
        }
    }

    let mut body = Vec::new();
    match content_len {
        Some(len) => {
            body.resize(len, 0u8);
            reader
                .read_exact(&mut body)
                .map_err(|e| format!("读响应体失败（期望 {len} 字节）: {e}"))?;
        }
        // 没有 Content-Length 就读到对端关闭为止
        None => {
            reader
                .read_to_end(&mut body)
                .map_err(|e| format!("读响应体失败: {e}"))?;
        }
    }
    Ok(Reply { status, body })
}

/// 小体量请求（/ping、/msg）：一次性带 body。
pub fn request_small(
    host: &str,
    port: u16,
    method: &str,
    path: &str,
    headers: &[(String, String)],
    body: &[u8],
    timeout: Duration,
) -> Result<Reply, String> {
    let mut stream = connect(host, port, timeout)?;
    stream
        .set_read_timeout(Some(timeout))
        .map_err(|e| format!("设置读超时失败: {e}"))?;
    stream
        .set_write_timeout(Some(timeout))
        .map_err(|e| format!("设置写超时失败: {e}"))?;
    write_head(&mut stream, method, path, headers, body.len() as u64)?;
    if !body.is_empty() {
        stream
            .write_all(body)
            .map_err(|e| format!("发送请求体失败: {e}"))?;
    }
    stream
        .flush()
        .map_err(|e| format!("刷新请求失败: {e}"))?;
    read_reply(&mut stream)
}

/// 流式 PUT（/file）：分块写文件并按块回调进度，避免整文件进内存。
pub fn put_stream<F: FnMut(u64, u64)>(
    host: &str,
    port: u16,
    path: &str,
    headers: &[(String, String)],
    file: &mut std::fs::File,
    size: u64,
    mut on_progress: F,
) -> Result<Reply, String> {
    const CHUNK: usize = 256 * 1024;
    let mut stream = connect(host, port, Duration::from_secs(5))?;
    // 大文件写耗时不定，写超时按块给足余量；读响应仍要超时，否则永久卡住
    stream
        .set_write_timeout(Some(Duration::from_secs(60)))
        .map_err(|e| format!("设置写超时失败: {e}"))?;
    stream
        .set_read_timeout(Some(Duration::from_secs(30)))
        .map_err(|e| format!("设置读超时失败: {e}"))?;
    write_head(&mut stream, "PUT", path, headers, size)?;

    let mut buf = vec![0u8; CHUNK];
    let mut sent: u64 = 0;
    loop {
        let n = file
            .read(&mut buf)
            .map_err(|e| format!("读本地文件失败: {e}"))?;
        if n == 0 {
            break;
        }
        stream
            .write_all(&buf[..n])
            .map_err(|e| format!("发送数据失败（已发 {sent}/{size}）: {e}"))?;
        sent += n as u64;
        on_progress(sent, size);
    }
    stream
        .flush()
        .map_err(|e| format!("刷新请求失败: {e}"))?;
    read_reply(&mut stream)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;
    use std::net::TcpListener;

    /// 起一个一次性假服务端，验证请求头组装与响应解析确实对得上。返回监听端口。
    fn fake_server(reply: &'static str) -> u16 {
        let ls = TcpListener::bind("127.0.0.1:0").unwrap();
        let port = ls.local_addr().unwrap().port();
        std::thread::spawn(move || {
            let (mut sock, _) = ls.accept().unwrap();
            let mut buf = [0u8; 2048];
            let _ = sock.read(&mut buf); // 请求会被客户端一次写完，这里不关心内容
            sock.write_all(reply.as_bytes()).unwrap();
            sock.flush().unwrap();
        });
        port
    }

    #[test]
    fn 解析带_content_length_的响应() {
        let port = fake_server("HTTP/1.1 200 OK\r\nContent-Length: 5\r\n\r\nhello");
        let r = request_small(
            "127.0.0.1",
            port,
            "GET",
            "/ping",
            &[],
            b"",
            Duration::from_secs(2),
        )
        .unwrap();
        assert_eq!(r.status, 200);
        assert_eq!(r.body_str(), "hello");
        assert!(r.ok());
    }

    #[test]
    fn 非_2xx_能被识别为失败() {
        let port = fake_server("HTTP/1.1 403 Forbidden\r\nContent-Length: 0\r\n\r\n");
        let r = request_small(
            "127.0.0.1",
            port,
            "GET",
            "/ping",
            &[],
            b"",
            Duration::from_secs(2),
        )
        .unwrap();
        assert_eq!(r.status, 403);
        assert!(!r.ok());
    }

    #[test]
    fn 连不上时返回错误而不是_panic() {
        // 1 端口基本不可能有监听
        let e = request_small("127.0.0.1", 1, "GET", "/ping", &[], b"", Duration::from_millis(300));
        assert!(e.is_err());
    }

    /// 用真的 tiny_http 服务端做互操作验证：手写客户端发出去的请求头与流式 body，
    /// 必须能被对端完整解析。假服务端测不出协议细节，而接收端用的就是这个库。
    fn echo_server() -> u16 {
        let server = tiny_http::Server::http("127.0.0.1:0").expect("临时端口监听失败");
        let port = server.server_addr().to_ip().expect("IPv4 监听地址").port();
        std::thread::spawn(move || {
            for mut req in server.incoming_requests() {
                let mut got = Vec::new();
                let _ = req.as_reader().read_to_end(&mut got);
                // 与 server.rs 同一套取头方式：名字统一小写后再查
                let map: std::collections::HashMap<String, String> = req
                    .headers()
                    .iter()
                    .map(|h| {
                        (
                            h.field.as_str().to_ascii_lowercase().to_string(),
                            h.value.as_str().to_string(),
                        )
                    })
                    .collect();
                let head = |k: &str| map.get(k).cloned().unwrap_or_default();
                let body = serde_json::json!({
                    "url": req.url(),
                    "method": req.method().as_str(),
                    "name": head("x-name"),
                    "sha": head("x-sha256"),
                    "len": got.len(),
                })
                .to_string();
                let _ = req.respond(tiny_http::Response::from_data(body));
            }
        });
        port
    }

    #[test]
    fn 与真实服务端互通_流式上传与中文头往返() {
        use crate::store;
        let port = echo_server();
        let dir = std::env::temp_dir().join(format!("http_xfer_{}", std::process::id()));
        fs::create_dir_all(&dir).expect("临时目录");
        let file_path = dir.join("payload.bin");
        let data = vec![7u8; 300 * 1024];
        fs::write(&file_path, &data).expect("写测试文件");
        let mut file = fs::File::open(&file_path).expect("开测试文件");

        let headers = vec![
            ("X-Name".to_string(), store::hdr_encode("图片对比 中文.bin")),
            ("X-Sha256".to_string(), store::sha256_hex(&data)),
        ];
        let r = put_stream(
            "127.0.0.1",
            port,
            "/file",
            &headers,
            &mut file,
            data.len() as u64,
            |_sent, _total| {},
        )
        .expect("流式 PUT 失败");
        let _ = fs::remove_file(&file_path);

        assert!(r.ok(), "状态码 {} body={}", r.status, r.body_str());
        let v: serde_json::Value = serde_json::from_str(&r.body_str()).expect("回显不是 JSON");
        assert_eq!(v["url"], "/file");
        assert_eq!(v["method"], "PUT");
        // 300KB 一字节不差地到了对端
        assert_eq!(v["len"].as_u64(), Some(data.len() as u64));
        // 中文文件名只能走 base64：编过去、解回来必须与原名字一致
        assert_eq!(
            store::hdr_decode(v["name"].as_str().unwrap()).as_deref(),
            Some("图片对比 中文.bin")
        );
        assert_eq!(v["sha"].as_str().unwrap(), store::sha256_hex(&data).as_str());
    }

    #[test]
    fn 非_ascii_请求头直接拒发而不是默默丢字() {
        // tiny_http 的头值只收 ASCII，这里必须在发送前就报错，
        // 否则中文文件名会安静地变成空字符串，落到收件箱里查不出原因
        let port = echo_server();
        let e = request_small(
            "127.0.0.1",
            port,
            "POST",
            "/msg",
            &[("X-Name".to_string(), "中文名字".to_string())],
            b"{}",
            Duration::from_secs(2),
        );
        assert!(e.is_err(), "含非 ASCII 的头应该被拦下");
    }
}
