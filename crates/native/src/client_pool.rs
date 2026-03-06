//! Client endpoint pool for connection reuse when allowPooling=true.
//!
//! Path B (endpoint-level pooling): Pool Endpoints per compatibility key.
//! Each connect() creates a new Connection from the pooled Endpoint.

use std::collections::HashMap;
use std::io;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{SystemTime, UNIX_EPOCH};

fn map_connecting_error(
    err: wtransport::error::ConnectingError,
) -> Box<dyn std::error::Error + Send + Sync> {
    match err {
        wtransport::error::ConnectingError::SessionRejected => {
            io::Error::other("E_RATE_LIMITED: server rejected WebTransport session request").into()
        }
        other => other.into(),
    }
}

/// Pool compatibility key.
#[derive(Clone, Debug, Hash, Eq, PartialEq)]
pub struct PoolKey {
    pub scheme: String,
    pub host: String,
    pub port: u16,
    pub sni: Option<String>,
    pub insecure_skip_verify: bool,
    pub has_pinned_hashes: bool,
    pub has_ca_pem: bool,
    pub require_unreliable: bool,
    pub congestion: String,
}

/// Shared state for a pooled endpoint.
struct PoolEntry {
    endpoint: wtransport::Endpoint<wtransport::endpoint::endpoint_side::Client>,
    active_refs: AtomicU64,
    last_used_ms: AtomicU64,
}

/// Guard that decrements pool refcount on drop.
pub struct PoolReleaseGuard {
    entry: Arc<PoolEntry>,
    _pool: Arc<ClientPoolManager>,
    _key: PoolKey,
}

impl Drop for PoolReleaseGuard {
    fn drop(&mut self) {
        self.entry.active_refs.fetch_sub(1, Ordering::Relaxed);
        self.entry.last_used_ms.store(now_ms(), Ordering::Relaxed);
    }
}

fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as u64
}

/// Pool limits.
const MAX_POOL_ENTRIES: usize = 256;
const MAX_SESSIONS_PER_KEY: u64 = 500;
const POOL_IDLE_TIMEOUT_MS: u64 = 60_000;

/// Global pool metrics for tests.
static POOL_HITS: AtomicU64 = AtomicU64::new(0);
static POOL_MISSES: AtomicU64 = AtomicU64::new(0);
static POOL_EVICT_IDLE: AtomicU64 = AtomicU64::new(0);
static POOL_EVICT_BROKEN: AtomicU64 = AtomicU64::new(0);

/// Client pool manager. Global lazy singleton.
pub struct ClientPoolManager {
    entries: Mutex<HashMap<PoolKey, Arc<PoolEntry>>>,
}

impl ClientPoolManager {
    pub fn new() -> Self {
        Self {
            entries: Mutex::new(HashMap::new()),
        }
    }

    /// Acquire a connection from the pool, or create a new endpoint and connect.
    /// Returns (Connection, PoolReleaseGuard) when pooling; guard must be held until session closes.
    pub async fn acquire_connect(
        self: &Arc<Self>,
        key: PoolKey,
        connect_url: &str,
        handshake_timeout_ms: u64,
        create_endpoint: impl FnOnce() -> std::result::Result<
            wtransport::Endpoint<wtransport::endpoint::endpoint_side::Client>,
            Box<dyn std::error::Error + Send + Sync>,
        >,
    ) -> std::result::Result<
        (
            wtransport::Connection,
            PoolReleaseGuard,
            bool, /* was_pool_hit */
        ),
        Box<dyn std::error::Error + Send + Sync>,
    > {
        let (entry, was_hit) = {
            let mut guard = self.entries.lock().map_err(|_| "pool lock poisoned")?;
            self.evict_idle_under_lock(&mut guard);
            if guard.len() >= MAX_POOL_ENTRIES {
                self.evict_one_under_lock(&mut guard);
            }
            match guard.get(&key) {
                Some(ent) => {
                    let refs = ent.active_refs.load(Ordering::Relaxed);
                    if refs >= MAX_SESSIONS_PER_KEY {
                        return Err("E_LIMIT_EXCEEDED: max sessions per pool key".into());
                    }
                    (Arc::clone(ent), true)
                }
                None => {
                    let endpoint = create_endpoint()?;
                    let ent = Arc::new(PoolEntry {
                        endpoint,
                        active_refs: AtomicU64::new(0),
                        last_used_ms: AtomicU64::new(now_ms()),
                    });
                    guard.insert(key.clone(), Arc::clone(&ent));
                    (ent, false)
                }
            }
        };

        if was_hit {
            POOL_HITS.fetch_add(1, Ordering::Relaxed);
        } else {
            POOL_MISSES.fetch_add(1, Ordering::Relaxed);
        }

        entry.active_refs.fetch_add(1, Ordering::Relaxed);

        let conn = tokio::time::timeout(
            tokio::time::Duration::from_millis(handshake_timeout_ms),
            entry.endpoint.connect(connect_url),
        )
        .await
        .map_err(|_| "E_HANDSHAKE_TIMEOUT")?
        .map_err(map_connecting_error)?;

        let release_guard = PoolReleaseGuard {
            entry: Arc::clone(&entry),
            _pool: Arc::clone(self),
            _key: key.clone(),
        };

        Ok((conn, release_guard, was_hit))
    }

    fn evict_idle_under_lock(&self, guard: &mut HashMap<PoolKey, Arc<PoolEntry>>) {
        let now = now_ms();
        let to_remove: Vec<PoolKey> = guard
            .iter()
            .filter(|(_, ent)| {
                ent.active_refs.load(Ordering::Relaxed) == 0
                    && now.saturating_sub(ent.last_used_ms.load(Ordering::Relaxed))
                        > POOL_IDLE_TIMEOUT_MS
            })
            .map(|(k, _)| k.clone())
            .collect();
        for k in to_remove {
            guard.remove(&k);
            POOL_EVICT_IDLE.fetch_add(1, Ordering::Relaxed);
        }
    }

    fn evict_one_under_lock(&self, guard: &mut HashMap<PoolKey, Arc<PoolEntry>>) {
        let _now = now_ms();
        let victim = guard
            .iter()
            .filter(|(_, ent)| ent.active_refs.load(Ordering::Relaxed) == 0)
            .min_by_key(|(_, ent)| ent.last_used_ms.load(Ordering::Relaxed))
            .map(|(k, _)| k.clone());
        if let Some(k) = victim {
            guard.remove(&k);
            POOL_EVICT_IDLE.fetch_add(1, Ordering::Relaxed);
        }
    }
}

impl Default for ClientPoolManager {
    fn default() -> Self {
        Self::new()
    }
}

/// Pool metrics snapshot for tests and observability.
#[derive(Default)]
pub struct PoolMetricsSnapshot {
    pub hits: u64,
    pub misses: u64,
    pub evict_idle: u64,
    pub evict_broken: u64,
}

pub fn pool_metrics_snapshot() -> PoolMetricsSnapshot {
    PoolMetricsSnapshot {
        hits: POOL_HITS.load(Ordering::Relaxed),
        misses: POOL_MISSES.load(Ordering::Relaxed),
        evict_idle: POOL_EVICT_IDLE.load(Ordering::Relaxed),
        evict_broken: POOL_EVICT_BROKEN.load(Ordering::Relaxed),
    }
}
