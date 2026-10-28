use quinn::ZeroRttAccepted;
use tokio::sync::watch;

/// Tracks whether a connection was established optimistically, before the TLS handshake
/// completed, and how that turned out.
///
/// A connection in the `Early` state carries data that is not covered by the full
/// cryptographic guarantees of a completed handshake: on the client side it is 0-RTT
/// data, replayable by an attacker; on the server side it is 0.5-RTT data, sent before
/// the client has been authenticated.
#[derive(Clone, Debug)]
pub(crate) enum ZeroRtt {
    /// The connection was established through a completed handshake.
    Off,

    /// The connection offered early data, the peer refused it, and the handshake has
    /// since completed. Whatever was sent early never reached the peer's application.
    Rejected,

    /// The connection was established optimistically. The channel yields whether the
    /// early data was accepted once the handshake completes.
    Early {
        accepted: watch::Receiver<Option<bool>>,

        /// Whether *this* endpoint is the one that sent the replayable early data.
        ///
        /// Only a client does. A server's optimistic data is 0.5-RTT, sent under
        /// handshake keys and never refused, so a server has nothing to redo when the
        /// client's 0-RTT turns out to have been rejected.
        ours: bool,
    },
}

impl ZeroRtt {
    /// Tracks a connection that sent 0-RTT data, i.e. a client.
    pub(crate) fn sending(accepted: ZeroRttAccepted) -> Self {
        Self::track(accepted, true)
    }

    /// Tracks a connection that offered 0.5-RTT data, i.e. a server.
    pub(crate) fn receiving(accepted: ZeroRttAccepted) -> Self {
        Self::track(accepted, false)
    }

    /// Watches a [`ZeroRttAccepted`] from [`quinn::Connecting::into_0rtt`].
    ///
    /// Note that despite what quinn's documentation says about server-side conversions
    /// always resolving to `true`, the future carries `accepted_0rtt()` on both sides, so
    /// a server sees `false` whenever it refused its client's early data.
    fn track(accepted: ZeroRttAccepted, ours: bool) -> Self {
        let (sender, receiver) = watch::channel(None);

        tokio::spawn(async move {
            let accepted = accepted.await;
            let _ = sender.send(Some(accepted));
        });

        Self::Early {
            accepted: receiver,
            ours,
        }
    }

    /// Whether the handshake has not completed yet.
    pub(crate) fn is_early(&self) -> bool {
        match self {
            Self::Off | Self::Rejected => false,
            Self::Early { accepted, .. } => accepted.borrow().is_none(),
        }
    }

    /// Waits for the handshake to complete, yielding whether the peer accepted the early
    /// data.
    ///
    /// A connection that never offered early data yields `true`: it never risked
    /// rejection, and its data reached the peer.
    pub(crate) async fn accepted(&self) -> bool {
        let receiver = match self {
            Self::Off => return true,
            Self::Rejected => return false,
            Self::Early { accepted, .. } => accepted,
        };

        let mut receiver = receiver.clone();

        loop {
            if let Some(accepted) = *receiver.borrow_and_update() {
                return accepted;
            }

            if receiver.changed().await.is_err() {
                // The tracking task is gone: the runtime is shutting down and the
                // handshake will never be observed to complete.
                return false;
            }
        }
    }

    /// Whether a failure happening now is explained by the peer refusing our early data.
    ///
    /// Answering means waiting for the handshake, since a connection still in its
    /// optimistic phase does not yet know. `Rejected` answers `false`: that state belongs
    /// to a connection whose early data was already refused and which is now running
    /// normally, so a fresh failure is a fresh problem.
    pub(crate) async fn explains_failure(&self) -> bool {
        match self {
            Self::Off | Self::Rejected => false,
            Self::Early { ours: false, .. } => false,
            Self::Early { ours: true, .. } => !self.accepted().await,
        }
    }
}
