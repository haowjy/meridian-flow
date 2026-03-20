# Onboarding

First-time user experience and free tier flow.

## Scope

- **Signup → credits** — new user signs up, gets free credits immediately (no card)
- **First project wizard** — create or import a project
- **Feature introduction** — brief tooltips or walkthrough for key features (editor, threads, skills)
- **Sample project** — optional pre-built project with example chapters + installed skills to explore

## Free Tier Flow

1. Sign up (email or Google OAuth)
2. Receive free credits (see [billing-design.md](../billing/billing-design.md))
3. Create first project or import existing work
4. Guided introduction to: editor, AI thread, @mentions, skills
5. First AI interaction within 2 minutes of signup

## Design Notes

- The "Meridian Moment" — the first AI interaction should demonstrate value immediately
- Don't gate core writing features — editor, explorer, file management are always free
- Credits only gate AI features
- Onboarding should be skippable for experienced users

## Future (post-v1)

- Import as activation moment (import story → auto-generate story bible)
- Interactive tutorial (guided writing session with AI)
- Template projects (novel, web serial, short story)

## Dependencies

- Auth (signup flow)
- Billing (free credit grant)
- Threads (first AI interaction)
- Design system (wizard, tooltips)
