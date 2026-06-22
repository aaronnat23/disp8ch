# Whisper Transcription Playbooks

Use this skill when the task involves speech-to-text, audio note transcription, or voice-to-text workflows.

## Use when
- The user wants to turn audio or voice messages into reliable text.
- A voice workflow should be validated end to end before broader automation depends on it.
- The task needs guidance around transcript quality, timestamps, or follow-up summaries.

## Workflow
1. Confirm the audio source, language, and expected output format.
2. Distinguish transcript generation from later summarization or action extraction.
3. Call out quality risks early: noisy audio, speaker overlap, missing punctuation, or missing timestamps.
4. Keep the first validation small so setup failures are easy to isolate.
5. Return both the raw transcription outcome and any cleaned follow-up summary separately.

## Deliverable
- Input assumptions.
- Transcription checklist.
- Quality risks.
- Suggested validation and follow-up summary shape.
