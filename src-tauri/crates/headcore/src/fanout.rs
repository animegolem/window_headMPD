//! Audio frame fan-out (ENGINE.md D11).
//!
//! The legacy engine keeps one `Option<Channel<Frame>>`, so a second `Viz` silently steals the
//! feed (`parity 3.2`). This is the replacement bookkeeping: every subscriber gets every frame, a
//! sink whose send fails is dropped, and a destroyed window takes its subscribers with it.
//!
//! It is generic over [`FrameSink`] so it has no Tauri dependency. Locking is the caller's
//! business: the glue keeps a `Mutex<Fanout<Frame, ChannelSink>>`, calls `send_all` from the audio
//! thread and the other methods from command threads. `Channel::send` posts to the webview and
//! does not wait on it, so holding that mutex across `send_all` is cheap.

use std::marker::PhantomData;

/// Somewhere a frame can be delivered. `Err` means the receiver is gone for good (a closed
/// webview, a destroyed window) and the sink is dropped on the spot; there is no retry.
///
/// The error is `()` because the fan-out only needs the verdict, not the reason.
#[allow(clippy::result_unit_err)]
pub trait FrameSink<F> {
    fn send(&self, frame: &F) -> Result<(), ()>;
}

/// Closures are sinks, which keeps tests to one line and lets `Box<dyn Fn(&F) -> Result<(), ()>>`
/// stand in when subscribers of different types share one `Fanout`.
///
/// `tauri::ipc::Channel` cannot implement [`FrameSink`] directly from the app crate (both the
/// trait and the type would be foreign there); the glue wraps it in a local newtype or a closure.
impl<F, T> FrameSink<F> for T
where
    T: Fn(&F) -> Result<(), ()>,
{
    fn send(&self, frame: &F) -> Result<(), ()> {
        self(frame)
    }
}

struct Subscriber<S> {
    id: u64,
    /// The window label the subscription came from (set by the host, never derived from a skin).
    label: String,
    sink: S,
    /// Whether this subscriber asked for PCM in its frames (D11, phase 2).
    pcm: bool,
}

/// The subscriber list. Subscribers are served in subscription order.
pub struct Fanout<F, S> {
    subs: Vec<Subscriber<S>>,
    /// Ids count up from 1 and are never reused, so `unsubscribe(id)` on a stale id cannot hit a
    /// newer subscriber, and 0 is never a live id.
    next_id: u64,
    // `F` only appears in `S: FrameSink<F>`; this ties it to the struct without owning an `F`.
    _frame: PhantomData<fn(&F)>,
}

impl<F, S> Fanout<F, S> {
    pub fn new() -> Self {
        Self {
            subs: Vec::new(),
            next_id: 1,
            _frame: PhantomData,
        }
    }

    pub fn len(&self) -> usize {
        self.subs.len()
    }

    pub fn is_empty(&self) -> bool {
        self.subs.is_empty()
    }

    /// True while any subscriber asked for PCM. The audio thread skips computing it otherwise.
    pub fn wants_pcm(&self) -> bool {
        self.subs.iter().any(|s| s.pcm)
    }

    /// Removes one subscriber by the id `subscribe` returned. Unknown ids are a no-op.
    pub fn unsubscribe(&mut self, id: u64) -> bool {
        match self.subs.iter().position(|s| s.id == id) {
            Some(i) => {
                self.subs.remove(i);
                true
            }
            None => false,
        }
    }

    /// Removes every subscriber that came from `label` and returns how many there were. Other
    /// labels are untouched.
    pub fn drop_label(&mut self, label: &str) -> usize {
        let before = self.subs.len();
        self.subs.retain(|s| s.label != label);
        before - self.subs.len()
    }
}

impl<F, S: FrameSink<F>> Fanout<F, S> {
    /// Registers `sink` and returns its id (the value `audio_subscribe` hands back to the page).
    pub fn subscribe(&mut self, label: &str, sink: S, pcm: bool) -> u64 {
        let id = self.next_id;
        self.next_id += 1;
        self.subs.push(Subscriber {
            id,
            label: label.to_owned(),
            sink,
            pcm,
        });
        id
    }

    /// Delivers `frame` to every subscriber. A sink that fails is dropped, and the others still
    /// get the frame. Returns how many sinks were dropped.
    pub fn send_all(&mut self, frame: &F) -> usize {
        let before = self.subs.len();
        self.subs.retain(|s| s.sink.send(frame).is_ok());
        before - self.subs.len()
    }
}

impl<F, S> Default for Fanout<F, S> {
    fn default() -> Self {
        Self::new()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicBool, Ordering};
    use std::sync::{Arc, Mutex};

    /// Records what it was sent and fails on demand.
    #[derive(Clone, Default)]
    struct TestSink {
        got: Arc<Mutex<Vec<u32>>>,
        broken: Arc<AtomicBool>,
    }

    impl TestSink {
        fn received(&self) -> Vec<u32> {
            self.got.lock().unwrap().clone()
        }
        fn break_it(&self) {
            self.broken.store(true, Ordering::SeqCst);
        }
    }

    impl FrameSink<u32> for TestSink {
        fn send(&self, frame: &u32) -> Result<(), ()> {
            if self.broken.load(Ordering::SeqCst) {
                return Err(());
            }
            self.got.lock().unwrap().push(*frame);
            Ok(())
        }
    }

    type Hub = Fanout<u32, TestSink>;
    /// Sinks of different types sharing one fan-out, through the closure impl.
    type DynSink<F> = Box<dyn Fn(&F) -> Result<(), ()>>;

    #[test]
    fn every_subscriber_receives_every_frame() {
        let mut hub = Hub::new();
        let sinks: Vec<TestSink> = (0..5).map(|_| TestSink::default()).collect();
        for (i, s) in sinks.iter().enumerate() {
            hub.subscribe(&format!("w{i}"), s.clone(), false);
        }
        assert_eq!(hub.send_all(&1), 0);
        assert_eq!(hub.send_all(&2), 0);
        for s in &sinks {
            assert_eq!(s.received(), vec![1, 2]);
        }
        assert_eq!(hub.len(), 5);
    }

    #[test]
    fn two_subscribers_on_one_label_both_receive() {
        // The legacy single slot let the second Viz steal the feed (parity 3.2).
        let mut hub = Hub::new();
        let (a, b) = (TestSink::default(), TestSink::default());
        hub.subscribe("main", a.clone(), false);
        hub.subscribe("main", b.clone(), false);
        hub.send_all(&7);
        assert_eq!(a.received(), vec![7]);
        assert_eq!(b.received(), vec![7]);
    }

    #[test]
    fn a_failing_sink_is_dropped_and_the_rest_still_receive() {
        let mut hub = Hub::new();
        let (a, bad, c) = (
            TestSink::default(),
            TestSink::default(),
            TestSink::default(),
        );
        hub.subscribe("w", a.clone(), false);
        hub.subscribe("w", bad.clone(), false);
        hub.subscribe("w", c.clone(), false);

        hub.send_all(&1);
        bad.break_it();
        // The failing sink sits between two healthy ones: both still get the frame.
        assert_eq!(hub.send_all(&2), 1);
        assert_eq!(hub.len(), 2);
        assert_eq!(a.received(), vec![1, 2]);
        assert_eq!(c.received(), vec![1, 2]);
        assert_eq!(bad.received(), vec![1]);

        // It is gone, not retried: nothing more is dropped and the survivors keep receiving.
        assert_eq!(hub.send_all(&3), 0);
        assert_eq!(a.received(), vec![1, 2, 3]);
        assert_eq!(c.received(), vec![1, 2, 3]);
    }

    #[test]
    fn every_sink_failing_empties_the_fanout() {
        let mut hub = Hub::new();
        let sinks = [TestSink::default(), TestSink::default()];
        for s in &sinks {
            s.break_it();
            hub.subscribe("w", s.clone(), true);
        }
        assert_eq!(hub.send_all(&1), 2);
        assert!(hub.is_empty());
        assert!(!hub.wants_pcm());
        assert_eq!(hub.send_all(&2), 0);
    }

    #[test]
    fn unsubscribe_removes_by_id() {
        let mut hub = Hub::new();
        let (a, b) = (TestSink::default(), TestSink::default());
        let ida = hub.subscribe("w", a.clone(), false);
        let idb = hub.subscribe("w", b.clone(), false);
        assert_ne!(ida, idb);

        assert!(hub.unsubscribe(ida));
        hub.send_all(&1);
        assert!(a.received().is_empty());
        assert_eq!(b.received(), vec![1]);

        // A second unsubscribe, an unknown id and the never-issued id 0 change nothing.
        assert!(!hub.unsubscribe(ida));
        assert!(!hub.unsubscribe(9_999));
        assert!(!hub.unsubscribe(0));
        assert_eq!(hub.len(), 1);
        assert!(hub.unsubscribe(idb));
        assert!(hub.is_empty());
    }

    #[test]
    fn ids_start_at_one_and_are_never_reused() {
        let mut hub = Hub::new();
        let first = hub.subscribe("w", TestSink::default(), false);
        assert_eq!(first, 1);
        assert!(hub.unsubscribe(first));
        let second = hub.subscribe("w", TestSink::default(), false);
        assert_eq!(second, 2);
        // The stale id cannot remove the newer subscriber.
        assert!(!hub.unsubscribe(first));
        assert_eq!(hub.len(), 1);
        // Dropping a label does not rewind the counter either.
        hub.drop_label("w");
        assert_eq!(hub.subscribe("w", TestSink::default(), false), 3);
    }

    #[test]
    fn drop_label_removes_only_that_labels_subscribers() {
        let mut hub = Hub::new();
        let (a1, a2, b) = (
            TestSink::default(),
            TestSink::default(),
            TestSink::default(),
        );
        hub.subscribe("A", a1.clone(), false);
        hub.subscribe("B", b.clone(), false);
        hub.subscribe("A", a2.clone(), false);

        assert_eq!(hub.drop_label("A"), 2);
        assert_eq!(hub.len(), 1);
        hub.send_all(&5);
        assert!(a1.received().is_empty());
        assert!(a2.received().is_empty());
        assert_eq!(b.received(), vec![5]);

        // A label with no subscribers, and a prefix of a live label, drop nothing.
        assert_eq!(hub.drop_label("A"), 0);
        assert_eq!(hub.drop_label(""), 0);
        let mut hub = Hub::new();
        hub.subscribe("main", TestSink::default(), false);
        assert_eq!(hub.drop_label("mai"), 0);
        assert_eq!(hub.drop_label("MAIN"), 0);
        assert_eq!(hub.len(), 1);
    }

    #[test]
    fn labels_are_plain_strings() {
        // Window labels are host-set, but a label that looks like a JS prototype key is still
        // just a label here.
        let mut hub = Hub::new();
        for label in ["__proto__", "constructor"] {
            hub.subscribe(label, TestSink::default(), false);
        }
        assert_eq!(hub.drop_label("__proto__"), 1);
        assert_eq!(hub.len(), 1);
        assert_eq!(hub.drop_label("constructor"), 1);
        assert!(hub.is_empty());
    }

    #[test]
    fn wants_pcm_tracks_the_flags() {
        let mut hub = Hub::new();
        assert!(!hub.wants_pcm(), "empty fan-out wants nothing");

        let plain = hub.subscribe("w", TestSink::default(), false);
        assert!(!hub.wants_pcm(), "a subscriber that did not ask");

        let pcm1 = hub.subscribe("w", TestSink::default(), true);
        assert!(hub.wants_pcm());
        let pcm2 = hub.subscribe("x", TestSink::default(), true);

        // True until the last PCM subscriber is gone, however it goes.
        hub.unsubscribe(pcm1);
        assert!(hub.wants_pcm());
        hub.drop_label("x");
        assert!(!hub.wants_pcm());
        assert!(!hub.unsubscribe(pcm2));

        // A failed sink stops counting too.
        let doomed = TestSink::default();
        hub.subscribe("y", doomed.clone(), true);
        assert!(hub.wants_pcm());
        doomed.break_it();
        hub.send_all(&1);
        assert!(!hub.wants_pcm());

        hub.unsubscribe(plain);
        assert!(hub.is_empty());
    }

    #[test]
    fn delivery_follows_subscription_order() {
        let order = Arc::new(Mutex::new(Vec::new()));
        let mut hub: Fanout<u32, DynSink<u32>> = Fanout::default();
        for tag in ["first", "second", "third"] {
            let order = order.clone();
            hub.subscribe(
                "w",
                Box::new(move |_| {
                    order.lock().unwrap().push(tag);
                    Ok(())
                }),
                false,
            );
        }
        hub.send_all(&0);
        assert_eq!(*order.lock().unwrap(), vec!["first", "second", "third"]);
    }

    #[test]
    fn closures_are_sinks() {
        let seen = Arc::new(Mutex::new(Vec::new()));
        let mut hub: Fanout<String, DynSink<String>> = Fanout::new();
        let log = seen.clone();
        hub.subscribe(
            "ok",
            Box::new(move |f| {
                log.lock().unwrap().push(f.clone());
                Ok(())
            }),
            false,
        );
        hub.subscribe("gone", Box::new(|_| Err(())), false);
        assert_eq!(hub.send_all(&"frame".to_string()), 1);
        assert_eq!(*seen.lock().unwrap(), vec!["frame".to_string()]);
        assert_eq!(hub.len(), 1);
    }

    #[test]
    fn a_fanout_of_send_sinks_can_live_in_a_mutex_shared_with_the_audio_thread() {
        // The glue keeps `Mutex<Fanout<..>>` in Tauri state; that needs Send, and Sync for the
        // mutex, without `F` getting in the way.
        fn assert_send<T: Send>() {}
        fn assert_sync<T: Sync>() {}
        assert_send::<Hub>();
        assert_sync::<Mutex<Hub>>();

        let hub = Arc::new(Mutex::new(Hub::new()));
        let sink = TestSink::default();
        hub.lock().unwrap().subscribe("w", sink.clone(), false);
        let audio = {
            let hub = hub.clone();
            std::thread::spawn(move || {
                for f in 0..10 {
                    hub.lock().unwrap().send_all(&f);
                }
            })
        };
        audio.join().unwrap();
        assert_eq!(sink.received(), (0..10).collect::<Vec<_>>());
    }
}
