use std::time::{Duration, Instant};

use serde::{Deserialize, Serialize};
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::TcpStream;
use tokio::time::timeout;

const HEALTH_TIMEOUT: Duration = Duration::from_secs(3);

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ServiceHealth {
    pub name: String,
    pub healthy: bool,
    pub latency_ms: Option<u64>,
}

struct ServiceDef {
    name: &'static str,
    port: u16,
    check: CheckKind,
}

enum CheckKind {
    Tcp,
    Http(&'static str),
}

const SERVICES: &[ServiceDef] = &[
    ServiceDef {
        name: "sovereign-shield",
        port: 3005,
        check: CheckKind::Http("/_auth/health"),
    },
    ServiceDef {
        name: "file-api",
        port: 3002,
        check: CheckKind::Http("/health"),
    },
    ServiceDef {
        name: "agent-bridge",
        port: 7700,
        check: CheckKind::Tcp,
    },
    ServiceDef {
        name: "caddy",
        port: 8443,
        check: CheckKind::Tcp,
    },
    ServiceDef {
        name: "term-proxy",
        port: 7701,
        check: CheckKind::Tcp,
    },
];

pub async fn check_all() -> Vec<ServiceHealth> {
    let mut results = Vec::with_capacity(SERVICES.len());
    for svc in SERVICES {
        let start = Instant::now();
        let healthy = match &svc.check {
            CheckKind::Tcp => check_tcp(svc.port).await,
            CheckKind::Http(path) => check_http(svc.port, path).await,
        };
        let latency_ms = if healthy {
            Some(start.elapsed().as_millis() as u64)
        } else {
            None
        };
        results.push(ServiceHealth {
            name: svc.name.to_string(),
            healthy,
            latency_ms,
        });
    }
    results
}

async fn check_tcp(port: u16) -> bool {
    timeout(HEALTH_TIMEOUT, TcpStream::connect(("127.0.0.1", port)))
        .await
        .is_ok_and(|r| r.is_ok())
}

async fn check_http(port: u16, path: &str) -> bool {
    let result = timeout(HEALTH_TIMEOUT, async {
        let mut stream = TcpStream::connect(("127.0.0.1", port)).await?;
        let req = format!("GET {path} HTTP/1.1\r\nHost: 127.0.0.1:{port}\r\nConnection: close\r\n\r\n");
        stream.write_all(req.as_bytes()).await?;
        let mut buf = [0u8; 256];
        let n = stream.read(&mut buf).await?;
        let resp = std::str::from_utf8(&buf[..n]).unwrap_or("");
        Ok::<bool, std::io::Error>(
            resp.starts_with("HTTP/1.1 200") || resp.starts_with("HTTP/1.0 200"),
        )
    })
    .await;

    matches!(result, Ok(Ok(true)))
}
