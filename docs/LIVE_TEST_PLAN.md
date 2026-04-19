# DigiRig On-Air Live Test Plan

To validate the **Unified Priority TX Queue** and the **Latency Acknowledgment (2000ms timeout)** logic on the air, please run through these three scenarios. 

This will test the "sweet spot" of the timer, ensure we don't transmit over people (barge-in protection), and confirm the audio quality of the generated WAV files.

## Prerequisites
1. OpenClaw Gateway running: `openclaw gateway start`
2. Turn on your radio and verify you are on a clear simplex frequency or coordinated repeater.
3. Keep the Gateway logs visible (`openclaw logs`) so you can watch the queue inject the tones.

---

## Scenario 1: The "Fast" Response (Timer DOES NOT Pop)
**Goal:** Prove that if the LLM thinks quickly, the 2000ms timer is cancelled and NO standby tone is played.
- **You (Radio):** "W6RGC/AI, what is your name?"
- **Expectation:** The AI should respond with "Seven" almost immediately.
- **Verification:** Listen closely. There should be NO "Stand by" beep or voice prompt before the answer.

## Scenario 2: The "Slow" Response (Timer POPS)
**Goal:** Prove that when the AI has to run a tool, the 2000ms timer triggers, plays the standby tone, unkeys, and then later keys up with the voice answer.
- **You (Radio):** "W6RGC/AI, search your memory for WB6DWP and tell me what you know about him." *(Or ask it to fetch the weather for a random city).*
- **Expectation:** 
  1. The AI keys up, says "Stand by", and unkeys.
  2. The channel remains silent for a few seconds.
  3. The AI keys up again and delivers the full answer.
- **Verification:** Ensure the "Stand by" voice is perfectly clear (no clipped first syllables) and that the channel successfully unkeyed in between.

## Scenario 3: The "Fatal Error" Override
**Goal:** Prove that if the system completely fails to dispatch the LLM, the `error.wav` jumps the queue.
- **Setup:** On your computer, briefly disable your internet connection (e.g., turn off Wi-Fi or unplug ethernet) so the LLM API fails.
- **You (Radio):** "W6RGC/AI, are you there?"
- **Expectation:** The API call will time out or instantly fail. The TX Queue should inject the error tone.
- **Verification:** You should hear the HAL 9000 homage: *"I'm sorry, I cannot do that Dave. W6RGC stroke AI."*
- **Teardown:** Turn your internet back on!

---

## Gathering Timing Results
While running these, please take note of:
1. Did 2000ms feel like too long of a silence before the "Stand by" kicked in? (If so, we can lower it to 1000ms).
2. Did the "Stand by" clip at the beginning? (If so, we may need to increase the pre-roll exclusively for the pre-recorded assets).
3. Did the audio volume of the generated `standby_short.wav` match the normal TTS voice?