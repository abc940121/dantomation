"""Tests for vad.py and the mac_client target switch. Stdlib unittest, no audio hardware.
Run: python modules/voice/test/test_vad.py   (or: python -m unittest discover modules/voice/test)
"""
import array
import math
import os
import random
import sys
import time
import unittest

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.dirname(HERE))

import vad  # noqa: E402
import mac_client  # noqa: E402
import speech_pipeline  # noqa: E402

F = vad.FRAME_MS
SAMPLES = vad.RATE * F // 1000


def silence(ms):
    return [bytes(SAMPLES * 2)] * (ms // F)


def tone(ms, amp=6000, hz=220):
    out = []
    n = 0
    for _ in range(ms // F):
        a = array.array('h', (int(amp * math.sin(2 * math.pi * hz * (n + k) / vad.RATE)) for k in range(SAMPLES)))
        n += SAMPLES
        out.append(a.tobytes())
    return out


def noise(ms, amp=150, seed=1):
    r = random.Random(seed)
    return [array.array('h', (r.randint(-amp, amp) for _ in range(SAMPLES))).tobytes() for _ in range(ms // F)]


class FrameRms(unittest.TestCase):
    def test_silence_zero(self):
        self.assertEqual(vad.frame_rms(bytes(640)), 0.0)

    def test_empty(self):
        self.assertEqual(vad.frame_rms(b''), 0.0)

    def test_constant(self):
        a = array.array('h', [1000] * 320).tobytes()
        self.assertAlmostEqual(vad.frame_rms(a), 1000.0, places=3)

    def test_sine_is_amp_over_root2(self):
        self.assertAlmostEqual(vad.frame_rms(tone(20, 10000)[0]), 10000 / math.sqrt(2), delta=60)


class FindUtterances(unittest.TestCase):
    def test_pure_silence(self):
        self.assertEqual(vad.find_utterances(silence(3000)), [])

    def test_quiet_noise_is_not_speech(self):
        self.assertEqual(vad.find_utterances(noise(3000)), [])

    def test_one_burst(self):
        fr = silence(1000) + tone(1000) + silence(1500)
        segs = vad.find_utterances(fr)
        self.assertEqual(len(segs), 1)
        s, e = segs[0]
        # burst occupies frames 50..100; preroll 200 ms = 10 frames before it
        self.assertEqual(s, 40)
        self.assertGreaterEqual(e, 100)
        self.assertLessEqual(e, 100 + 700 // F + 1)

    def test_burst_in_noise(self):
        fr = noise(1000) + tone(800) + noise(1500, seed=2)
        self.assertEqual(len(vad.find_utterances(fr)), 1)

    def test_two_bursts_far_apart(self):
        fr = silence(500) + tone(600) + silence(1500) + tone(600) + silence(1500)
        self.assertEqual(len(vad.find_utterances(fr)), 2)

    def test_short_pause_merges(self):
        fr = silence(500) + tone(600) + silence(300) + tone(600) + silence(1500)
        self.assertEqual(len(vad.find_utterances(fr)), 1)

    def test_hangover_boundary_splits(self):
        fr = silence(500) + tone(600) + silence(900) + tone(600) + silence(1500)
        self.assertEqual(len(vad.find_utterances(fr)), 2)

    def test_too_short_dropped(self):
        fr = silence(500) + tone(100) + silence(1500)
        self.assertEqual(vad.find_utterances(fr), [])

    def test_min_length_kept_at_threshold(self):
        fr = silence(500) + tone(300) + silence(1500)
        self.assertEqual(len(vad.find_utterances(fr)), 1)

    def test_burst_at_start_of_stream(self):
        fr = tone(600) + silence(1500)
        segs = vad.find_utterances(fr)
        self.assertEqual(len(segs), 1)
        self.assertEqual(segs[0][0], 0)

    def test_utterance_open_at_end_is_flushed(self):
        segs = vad.find_utterances(silence(300) + tone(800))
        self.assertEqual(len(segs), 1)
        self.assertEqual(segs[0][1], 15 + 40)

    def test_max_length_cuts(self):
        segs = vad.find_utterances(silence(200) + tone(5000), max_ms=2000)
        self.assertGreaterEqual(len(segs), 2)
        for s, e in segs:
            self.assertLessEqual((e - s) * F, 2000)

    def test_threshold_param(self):
        fr = silence(500) + tone(800, amp=500) + silence(1500)
        self.assertEqual(vad.find_utterances(fr, min_rms=1000), [])
        self.assertEqual(len(vad.find_utterances(fr, min_rms=100, ratio=1.5)), 1)

    def test_steady_hum_raises_floor(self):
        # loud constant hum: first it counts as speech under a low floor, so give the floor time on a lower hum
        hum = noise(2000, amp=380)
        fr = hum + tone(800, amp=6000) + noise(1500, amp=380, seed=3)
        self.assertEqual(len(vad.find_utterances(fr)), 1)

    def test_preroll_zero(self):
        segs = vad.find_utterances(silence(500) + tone(600) + silence(1500), preroll_ms=0)
        self.assertEqual(segs[0][0], 25)


class SegmenterStream(unittest.TestCase):
    def run_stream(self, frames, **kw):
        seg = vad.Segmenter(**kw)
        out = []
        for fr in frames:
            u = seg.feed(fr)
            if u is not None:
                out.append((seg.last_start_frame, u))
        u = seg.flush()
        if u is not None:
            out.append((seg.last_start_frame, u))
        return out

    def test_matches_find_utterances(self):
        fr = silence(500) + tone(600) + silence(300) + tone(400) + silence(1500) + tone(500) + silence(1000)
        batch = vad.find_utterances(fr)
        stream = self.run_stream(fr)
        self.assertEqual([s for s, _ in stream], [s for s, _ in batch])
        for (s, e), (_, pcm) in zip(batch, stream):
            self.assertEqual(pcm, b''.join(fr[s:e]))

    def test_nothing_on_silence(self):
        self.assertEqual(self.run_stream(silence(2000)), [])

    def test_reset_discards_partial(self):
        seg = vad.Segmenter()
        for fr in tone(400):
            seg.feed(fr)
        seg.reset()
        got = [seg.feed(fr) for fr in silence(1500)]
        self.assertEqual([g for g in got if g], [])
        self.assertIsNone(seg.flush())

    def test_buffer_stays_bounded_in_silence(self):
        seg = vad.Segmenter()
        for fr in silence(10000):
            seg.feed(fr)
        self.assertLess(len(seg.buf), 40)

    def test_chunk_frames(self):
        pcm = b''.join(tone(100))
        self.assertEqual(len(list(vad.chunk_frames(pcm))), 5)
        self.assertEqual(len(list(vad.chunk_frames(pcm + b'xx'))), 5)


class Target(unittest.TestCase):
    def test_default_is_turn(self):
        t = mac_client.resolve_target({})
        self.assertEqual(t['kind'], 'turn')
        self.assertEqual(t['url'], 'http://127.0.0.1:8790/turn')

    def test_turn_uses_bridge_env(self):
        t = mac_client.resolve_target({'BRIDGE_URL': 'http://h:1/', 'BRIDGE_TOKEN': 'tk'})
        self.assertEqual(t['url'], 'http://h:1/turn')
        self.assertEqual(t['headers']['Authorization'], 'Bearer tk')

    def test_explicit_turn(self):
        self.assertEqual(mac_client.resolve_target({'TEXT_TARGET': 'turn'})['kind'], 'turn')

    def test_voice_chat(self):
        t = mac_client.resolve_target({'TEXT_TARGET': 'voice-chat', 'VOICE_CHAT_URL': 'http://h:2'})
        self.assertEqual(t['kind'], 'voice-chat')
        self.assertEqual(t['url'], 'http://h:2/m/voice-chat/utterance')
        self.assertNotIn('Authorization', t['headers'])

    def test_voice_chat_token_and_default_url(self):
        t = mac_client.resolve_target({'TEXT_TARGET': ' Voice-Chat ', 'VOICE_CHAT_TOKEN': 'abc'})
        self.assertEqual(t['url'], 'http://127.0.0.1:7420/m/voice-chat/utterance')
        self.assertEqual(t['headers']['Authorization'], 'Bearer abc')

    def test_unknown_target_raises(self):
        with self.assertRaises(ValueError):
            mac_client.resolve_target({'TEXT_TARGET': 'nope'})

    def test_payloads(self):
        turn = mac_client.resolve_target({})
        vc = mac_client.resolve_target({'TEXT_TARGET': 'voice-chat'})
        self.assertEqual(mac_client.target_payload(turn, 'hi', 5), {'text': 'hi'})
        self.assertEqual(mac_client.target_payload(vc, 'hi', 5), {'text': 'hi', 'spokenAt': 5})
        self.assertIn('spokenAt', mac_client.target_payload(vc, 'hi'))


class Pipeline(unittest.TestCase):
    def make(self, prefetch=2):
        import threading
        self.log, self.gates, self.played = [], {}, []
        self.release = threading.Event()

        def synth(t):
            self.log.append('synth:' + t)
            g = self.gates.setdefault(t, threading.Event())
            g.wait(2)
            return 'A:' + t

        def play(a):
            self.played.append(a)
            self.release.wait(2)

        return speech_pipeline.SpeechPipeline(synth, play, prefetch=prefetch)

    def test_prefetch_window_and_order(self):
        p = self.make(2)
        for t in 'abcde':
            p.push(t)
        time.sleep(0.1)
        self.assertEqual(sorted(self.log), ['synth:a', 'synth:b', 'synth:c'])
        for t in 'abcde':
            self.gates.setdefault(t, __import__('threading').Event()).set()
        self.release.set()
        p.join(3)
        self.assertEqual(self.played, ['A:a', 'A:b', 'A:c', 'A:d', 'A:e'])

    def test_cancel_drops_queue(self):
        p = self.make(3)
        for t in ('one', 'two', 'three'):
            p.push(t)
        self.gates['one'] = self.gates.get('one') or __import__('threading').Event()
        self.gates['one'].set()
        time.sleep(0.1)
        p.cancel()
        for t in ('two', 'three'):
            self.gates.setdefault(t, __import__('threading').Event()).set()
        self.release.set()
        p.join(3)
        self.assertEqual(self.played, ['A:one'])
        self.assertEqual(p.pending(), 0)


class Gate(unittest.TestCase):
    def test_mute_while_playing_and_300ms_after(self):
        now = [100.0]
        g = mac_client.PlaybackGate(clock=lambda: now[0])
        self.assertFalse(g.muted())
        g.start()
        now[0] += 5
        self.assertTrue(g.muted())
        g.end()
        now[0] += 0.29
        self.assertTrue(g.muted())
        now[0] += 0.02
        self.assertFalse(g.muted())

    def test_overlapping_playbacks(self):
        g = mac_client.PlaybackGate(clock=lambda: 1.0)
        g.start(); g.start(); g.end()
        self.assertTrue(g.muted())

    def test_listen_drops_audio_while_muted(self):
        now = [10.0]
        g = mac_client.PlaybackGate(clock=lambda: now[0])
        g.start()
        got = []
        mac_client.listen(frames=iter(silence(200) + tone(600) + silence(1500)), gate=g,
                          on_utterance=lambda pcm, at: got.append(pcm))
        self.assertEqual(got, [])

    def test_listen_delivers_when_open(self):
        g = mac_client.PlaybackGate(clock=lambda: 10.0)
        got = []
        mac_client.listen(frames=iter(silence(200) + tone(600) + silence(1500)), gate=g,
                          on_utterance=lambda pcm, at: got.append((pcm, at)))
        self.assertEqual(len(got), 1)
        self.assertGreater(got[0][1], time.time() * 1000 - 60000)


if __name__ == '__main__':
    unittest.main(verbosity=1)
