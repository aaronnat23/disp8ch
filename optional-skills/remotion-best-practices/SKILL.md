---
platforms: [linux, macos, windows]
setup_notes:
  - Source: skills.sh / remotion-dev/skills remotion-best-practices. Added as an optional Disp8ch skill and disabled by default.
---

# Remotion Best Practices

Build, inspect, and improve Remotion video projects with React-based composition discipline.

## Use When

- Creating or editing a Remotion video, animation, title sequence, explainer, or social clip.
- Reviewing Remotion components, timelines, frame math, assets, audio, or rendering scripts.
- Converting a design or storyboard into a programmatic video.

## Playbook

1. Check whether a Remotion project already exists before scaffolding anything.
2. Keep compositions small and named around the deliverable, aspect ratio, duration, and frame rate.
3. Animate with `useCurrentFrame()`, `interpolate()`, and easing functions instead of ad hoc timers.
4. Keep frame ranges explicit. Avoid magic numbers without naming the scene or transition they control.
5. Use reusable React components for repeated lower-thirds, cards, captions, charts, and scene shells.
6. Validate media paths, fonts, and asset sizes before rendering.
7. Render a small preview or still frame before committing to a long export when tools are available.

## Project Setup Notes

- For a blank workspace, a typical Remotion starter command is `npx create-video@latest`.
- Use the app or repo's existing package manager and scripts if the project already has Remotion configured.
- Keep generated video assets out of source control unless the repo explicitly tracks them.

## Guardrails

- Do not install or scaffold without user approval when the request is only a plan.
- Do not assume Remotion is installed; inspect `package.json` first.
- Do not enable this by default; it is useful only for video-producing agents.

