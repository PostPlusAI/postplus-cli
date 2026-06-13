// GENERATED from apps/web/lib/server/postplus-cli/hosted-execution-manifest.ts
// and packages/vibe_marketing/public-skill-metadata.json execution bindings.
// Do not edit by hand. Run `pnpm hosted-execution-manifest:sync` to regenerate.

export const HOSTED_EXECUTION_MANIFEST_SCHEMA_VERSION =
  'hosted-execution-manifest/v1' as const;

export const HOSTED_EXECUTION_MANIFESTS = {
  "audio-transcription": {
    "skill": "audio-transcription",
    "mode": "cli-runner",
    "surface": "flags",
    "verb": "transcribe",
    "domain": "media",
    "capability": "media-generation",
    "endpointKeys": [
      "transcription-whisper",
      "transcription-whisper-turbo"
    ],
    "endpoints": [
      {
        "endpointKey": "transcription-whisper",
        "provider": "wavespeed",
        "providerModelPath": "wavespeed-ai/openai-whisper",
        "fields": [
          {
            "name": "audio",
            "class": "intent",
            "flag": "--audio",
            "type": "media-url",
            "required": true
          },
          {
            "name": "duration_seconds",
            "class": "intent",
            "flag": "--duration-seconds",
            "type": "number",
            "required": true
          },
          {
            "name": "task",
            "class": "default",
            "flag": "--task",
            "type": "string",
            "enumValues": [
              "transcribe",
              "translate"
            ],
            "default": "transcribe",
            "required": false
          },
          {
            "name": "language",
            "class": "default",
            "flag": "--language",
            "type": "string",
            "default": "auto",
            "required": false
          },
          {
            "name": "enable_timestamps",
            "class": "default",
            "flag": "--enable-timestamps",
            "type": "boolean",
            "default": false,
            "required": false
          },
          {
            "name": "prompt",
            "class": "intent",
            "flag": "--prompt",
            "type": "string",
            "required": false
          },
          {
            "name": "mediaSeconds",
            "class": "runner-managed",
            "flag": null,
            "type": "number",
            "required": false,
            "derivedFrom": "duration_seconds"
          },
          {
            "name": "operationId",
            "class": "runner-managed",
            "flag": null,
            "type": "string",
            "required": false
          },
          {
            "name": "quoteConfirmationToken",
            "class": "runner-managed",
            "flag": null,
            "type": "string",
            "required": false
          }
        ],
        "billingDimensions": [
          "mediaSeconds"
        ]
      },
      {
        "endpointKey": "transcription-whisper-turbo",
        "provider": "wavespeed",
        "providerModelPath": "wavespeed-ai/openai-whisper-turbo",
        "fields": [
          {
            "name": "audio",
            "class": "intent",
            "flag": "--audio",
            "type": "media-url",
            "required": true
          },
          {
            "name": "duration_seconds",
            "class": "intent",
            "flag": "--duration-seconds",
            "type": "number",
            "required": true
          },
          {
            "name": "task",
            "class": "default",
            "flag": "--task",
            "type": "string",
            "enumValues": [
              "transcribe",
              "translate"
            ],
            "default": "transcribe",
            "required": false
          },
          {
            "name": "language",
            "class": "default",
            "flag": "--language",
            "type": "string",
            "default": "auto",
            "required": false
          },
          {
            "name": "enable_timestamps",
            "class": "default",
            "flag": "--enable-timestamps",
            "type": "boolean",
            "default": false,
            "required": false
          },
          {
            "name": "prompt",
            "class": "intent",
            "flag": "--prompt",
            "type": "string",
            "required": false
          },
          {
            "name": "mediaSeconds",
            "class": "runner-managed",
            "flag": null,
            "type": "number",
            "required": false,
            "derivedFrom": "duration_seconds"
          },
          {
            "name": "operationId",
            "class": "runner-managed",
            "flag": null,
            "type": "string",
            "required": false
          },
          {
            "name": "quoteConfirmationToken",
            "class": "runner-managed",
            "flag": null,
            "type": "string",
            "required": false
          }
        ],
        "billingDimensions": [
          "mediaSeconds"
        ]
      }
    ]
  }
} as const;
