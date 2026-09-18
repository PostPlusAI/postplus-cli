# Getting Started with PostPlus

This reference owns the user-facing capability introduction. Other entrypoints
should link here or derive copy from it, not maintain separate capability lists.
Use the user's language. The English introduction below is the editorial source;
translate its meaning naturally rather than enforcing a word count in each language.

## Progressive Disclosure

- For a general start request, give one value sentence and three or four task
  directions. Invite a plain-language description; never require skill names.
- For “what can PostPlus do?” or a request to browse all capabilities, give the
  full introduction below, adapted to the user's language and known context.
- A specific task skips the tour. Read the matching released skill and ask only
  for inputs needed for its next meaningful step, reusing information already given.
- These instructions describe guidance, not automatic startup behavior. The agent
  must discover this entrypoint from the user's request in a session that loaded it.
- Do not run login, readiness probes, collection, generation, or publishing just
  to demonstrate capabilities. Explain login or cost when needed by the chosen
  workflow; existing authorization and quote-confirmation rules remain binding.
- After a task, suggest only a relevant next step. Do not restart onboarding.

## Short Opening

> PostPlus helps turn public information and creative ideas into evidence-backed research, content plans, and image, video, and audio assets.
>
> Start with one of four directions: find market and content opportunities, break down reference work, plan ads and content, or make assets and prepare to publish. What are you working on? Describe it in your own words, or ask for the full introduction.

## Full Introduction — English Source

PostPlus helps you move from “I don't know what to make” or “I have an idea but need assets” to useful work you can build on. You do not need to remember skill names or commands. Describe your goal and share links, information, or files; I will ask for the inputs needed for the next step and take you into the appropriate workflow.

**Find topics and market signals.** Want to promote a product but unsure what your audience is discussing? Explore public social posts, comments, and search trends for questions, language, and examples. Get source-backed leads and possible directions. Share your product, target market, and platform of interest to begin. Public discussion and search interest are research evidence, not guarantees of sales or conversion.

**Understand accounts and reference work.** Found an account, an ad, or a set of images and want to know what is worth learning from? Organize public content samples, examine audience feedback, or break down a video's opening, shots, pacing, and visual evidence into a reusable analysis report. Provide a link or readable file and the question you want answered; you do not need to choose the analysis tool first.

**Turn product information into a content plan.** Have selling points but need a clear way to communicate them? Combine verified product facts and references into an audience definition, central message, ad angles, script, and storyboard. Whether you want a creator-style ad, an explainer, a product demonstration, or animation, the plan starts with claims you can support. Share your product information, intended publishing context, and existing assets so we can develop a direction to discuss.

**Make images, videos, and audio.** Once the direction is clear, continue with product images, covers, character references, storyboard images, short videos, or voiceovers. You can also work from reference assets or make multiple variations. Tell me the intended use, style, and elements that must stay consistent. I will gather the inputs required by the supported workflow and explain any required payment confirmation before generation. Generated results may still need review and revision.

**Organize existing material for production.** Have a recording or video and need a transcript, subtitles, or editing advice? Extract time-aligned content, prepare subtitle files, and plan where to keep spoken footage or add supporting visuals. You can also organize a creative idea into a reusable production workflow. Share the file and the output you need. An editing plan is a handoff for production, not a claim that a finished video has already been rendered.

**Review results and prepare to publish.** Once you have assets, record your judgments about the images, sound, and content, then organize revisions. You can also prepare publishing drafts and previews for supported, connected social accounts. Share the asset, platform, and goal. Actual sending follows the required confirmation steps; browsing this introduction does not authorize publishing.

You do not have to follow the entire sequence. Try “Analyze this video,” “Give me three ad directions for this product,” or “Turn this recording into subtitles.” Start with whichever step is useful now.

## Internal Routing (Not a User Menu)

Read the chosen skill before execution; its supported inputs and boundaries win.
The introduction is not authorization to bypass missing capabilities.

| User job | Existing route |
| --- | --- |
| Public content, audience, or search research | Platform research skill; `social-media-extractor` for Instagram/Meta routing; `google-trends-research` for search interest |
| Reference analysis | `media-analysis`, or `shot-by-shot-analysis` when multiple references define production language |
| Campaign direction and script | `benchmark-to-brief`, then the appropriate released ad skill |
| Image/video/audio production | `generation-router`, then the matching generation route and runner |
| Transcription/subtitles/edit plan | `media-router`, then transcription, `subtitle-packager`, or `editing-decision-engine` |
| Reusable production workflow | `workflow-creation` |
| Review or publishing | `creative-qa` or `social-media-publisher` |

## Illustrative First Conversation (Not Live Acceptance Evidence)

User: Help me get started with PostPlus.
Agent: [Use the short opening above in the user's language.]
User: I sell portable coffee makers and want an ad, but I don't have any assets yet.
Agent: Let's first turn the product's strengths into an ad direction, then decide which assets to make. Who is the audience, and where will you post it? Share a product description or link to get started.
User: Office workers on TikTok. Here is the product information…
Agent: I will identify the supported selling points in this information and draft an ad direction and short script for office workers. I will not present unsupported results as facts.

The next action follows the selected ad/brief contract. This example makes no
provider call and grants no payment or publishing approval. Static reference and
contract checks cannot prove discovery or routing in a real zero-context agent
session; that requires a separate natural-language agent rehearsal.
