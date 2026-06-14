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
  },
  "image-batch-runner": {
    "skill": "image-batch-runner",
    "mode": "cli-runner",
    "surface": "flags",
    "verb": "create",
    "domain": "media",
    "capability": "media-generation",
    "endpointKeys": [
      "image-gpt-image-2-text",
      "image-gpt-image-2-edit",
      "image-nano-banana-2-text",
      "image-nano-banana-2-edit",
      "image-nano-banana-pro-text-1k",
      "image-nano-banana-pro-text-2k",
      "image-nano-banana-pro-text-4k",
      "image-nano-banana-pro-edit-1k",
      "image-nano-banana-pro-edit-2k",
      "image-nano-banana-pro-edit-4k",
      "image-seedream-v5-lite-text",
      "image-seedream-v5-lite-sequential",
      "image-seedream-v5-lite-edit",
      "image-seedream-v5-lite-edit-sequential"
    ],
    "endpoints": [
      {
        "endpointKey": "image-gpt-image-2-text",
        "provider": "wavespeed",
        "providerModelPath": "openai/gpt-image-2/text-to-image",
        "fields": [
          {
            "name": "prompt",
            "class": "intent",
            "flag": "--prompt",
            "type": "string",
            "required": true
          },
          {
            "name": "aspect_ratio",
            "class": "default",
            "flag": "--aspect-ratio",
            "type": "string",
            "default": "9:16",
            "required": false
          },
          {
            "name": "resolution",
            "class": "default",
            "flag": "--resolution",
            "type": "string",
            "enumValues": [
              "1k",
              "2k",
              "4k"
            ],
            "default": "1k",
            "required": false
          },
          {
            "name": "quality",
            "class": "default",
            "flag": "--quality",
            "type": "string",
            "enumValues": [
              "low",
              "medium",
              "high"
            ],
            "default": "medium",
            "required": false
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
          "imageSize",
          "quality"
        ]
      },
      {
        "endpointKey": "image-gpt-image-2-edit",
        "provider": "wavespeed",
        "providerModelPath": "openai/gpt-image-2/edit",
        "fields": [
          {
            "name": "prompt",
            "class": "intent",
            "flag": "--prompt",
            "type": "string",
            "required": true
          },
          {
            "name": "images",
            "class": "intent",
            "flag": "--reference-image",
            "type": "media-url",
            "repeatable": true,
            "required": true
          },
          {
            "name": "aspect_ratio",
            "class": "default",
            "flag": "--aspect-ratio",
            "type": "string",
            "default": "9:16",
            "required": false
          },
          {
            "name": "resolution",
            "class": "default",
            "flag": "--resolution",
            "type": "string",
            "enumValues": [
              "1k",
              "2k",
              "4k"
            ],
            "default": "1k",
            "required": false
          },
          {
            "name": "quality",
            "class": "default",
            "flag": "--quality",
            "type": "string",
            "enumValues": [
              "low",
              "medium",
              "high"
            ],
            "default": "medium",
            "required": false
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
          "imageSize",
          "quality"
        ]
      },
      {
        "endpointKey": "image-nano-banana-2-text",
        "provider": "wavespeed",
        "providerModelPath": "google/nano-banana-2/text-to-image",
        "fields": [
          {
            "name": "prompt",
            "class": "intent",
            "flag": "--prompt",
            "type": "string",
            "required": true
          },
          {
            "name": "aspect_ratio",
            "class": "default",
            "flag": "--aspect-ratio",
            "type": "string",
            "default": "9:16",
            "required": false
          },
          {
            "name": "resolution",
            "class": "default",
            "flag": "--resolution",
            "type": "string",
            "enumValues": [
              "0.5k",
              "1k",
              "2k",
              "4k"
            ],
            "default": "1k",
            "required": false
          },
          {
            "name": "enable_web_search",
            "class": "default",
            "flag": "--enable-web-search",
            "type": "boolean",
            "default": false,
            "required": false
          },
          {
            "name": "output_format",
            "class": "default",
            "flag": "--output-format",
            "type": "string",
            "default": "png",
            "required": false
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
          "imageSize"
        ]
      },
      {
        "endpointKey": "image-nano-banana-2-edit",
        "provider": "wavespeed",
        "providerModelPath": "google/nano-banana-2/edit",
        "fields": [
          {
            "name": "prompt",
            "class": "intent",
            "flag": "--prompt",
            "type": "string",
            "required": true
          },
          {
            "name": "images",
            "class": "intent",
            "flag": "--reference-image",
            "type": "media-url",
            "repeatable": true,
            "required": true
          },
          {
            "name": "aspect_ratio",
            "class": "default",
            "flag": "--aspect-ratio",
            "type": "string",
            "default": "9:16",
            "required": false
          },
          {
            "name": "resolution",
            "class": "default",
            "flag": "--resolution",
            "type": "string",
            "enumValues": [
              "0.5k",
              "1k",
              "2k",
              "4k"
            ],
            "default": "1k",
            "required": false
          },
          {
            "name": "enable_web_search",
            "class": "default",
            "flag": "--enable-web-search",
            "type": "boolean",
            "default": false,
            "required": false
          },
          {
            "name": "output_format",
            "class": "default",
            "flag": "--output-format",
            "type": "string",
            "default": "png",
            "required": false
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
          "imageSize"
        ]
      },
      {
        "endpointKey": "image-nano-banana-pro-text-1k",
        "provider": "wavespeed",
        "providerModelPath": "google/nano-banana-pro/text-to-image",
        "fields": [
          {
            "name": "prompt",
            "class": "intent",
            "flag": "--prompt",
            "type": "string",
            "required": true
          },
          {
            "name": "aspect_ratio",
            "class": "default",
            "flag": "--aspect-ratio",
            "type": "string",
            "default": "9:16",
            "required": false
          },
          {
            "name": "resolution",
            "class": "default",
            "flag": "--resolution",
            "type": "string",
            "enumValues": [
              "1k"
            ],
            "default": "1k",
            "required": false
          },
          {
            "name": "output_format",
            "class": "default",
            "flag": "--output-format",
            "type": "string",
            "default": "png",
            "required": false
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
          "imageSize"
        ]
      },
      {
        "endpointKey": "image-nano-banana-pro-text-2k",
        "provider": "wavespeed",
        "providerModelPath": "google/nano-banana-pro/text-to-image",
        "fields": [
          {
            "name": "prompt",
            "class": "intent",
            "flag": "--prompt",
            "type": "string",
            "required": true
          },
          {
            "name": "aspect_ratio",
            "class": "default",
            "flag": "--aspect-ratio",
            "type": "string",
            "default": "9:16",
            "required": false
          },
          {
            "name": "resolution",
            "class": "default",
            "flag": "--resolution",
            "type": "string",
            "enumValues": [
              "2k"
            ],
            "default": "2k",
            "required": false
          },
          {
            "name": "output_format",
            "class": "default",
            "flag": "--output-format",
            "type": "string",
            "default": "png",
            "required": false
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
          "imageSize"
        ]
      },
      {
        "endpointKey": "image-nano-banana-pro-text-4k",
        "provider": "wavespeed",
        "providerModelPath": "google/nano-banana-pro/text-to-image",
        "fields": [
          {
            "name": "prompt",
            "class": "intent",
            "flag": "--prompt",
            "type": "string",
            "required": true
          },
          {
            "name": "aspect_ratio",
            "class": "default",
            "flag": "--aspect-ratio",
            "type": "string",
            "default": "9:16",
            "required": false
          },
          {
            "name": "resolution",
            "class": "default",
            "flag": "--resolution",
            "type": "string",
            "enumValues": [
              "4k"
            ],
            "default": "4k",
            "required": false
          },
          {
            "name": "output_format",
            "class": "default",
            "flag": "--output-format",
            "type": "string",
            "default": "png",
            "required": false
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
          "imageSize"
        ]
      },
      {
        "endpointKey": "image-nano-banana-pro-edit-1k",
        "provider": "wavespeed",
        "providerModelPath": "google/nano-banana-pro/edit",
        "fields": [
          {
            "name": "prompt",
            "class": "intent",
            "flag": "--prompt",
            "type": "string",
            "required": true
          },
          {
            "name": "images",
            "class": "intent",
            "flag": "--reference-image",
            "type": "media-url",
            "repeatable": true,
            "required": true
          },
          {
            "name": "aspect_ratio",
            "class": "default",
            "flag": "--aspect-ratio",
            "type": "string",
            "default": "9:16",
            "required": false
          },
          {
            "name": "resolution",
            "class": "default",
            "flag": "--resolution",
            "type": "string",
            "enumValues": [
              "1k"
            ],
            "default": "1k",
            "required": false
          },
          {
            "name": "output_format",
            "class": "default",
            "flag": "--output-format",
            "type": "string",
            "default": "png",
            "required": false
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
          "imageSize"
        ]
      },
      {
        "endpointKey": "image-nano-banana-pro-edit-2k",
        "provider": "wavespeed",
        "providerModelPath": "google/nano-banana-pro/edit",
        "fields": [
          {
            "name": "prompt",
            "class": "intent",
            "flag": "--prompt",
            "type": "string",
            "required": true
          },
          {
            "name": "images",
            "class": "intent",
            "flag": "--reference-image",
            "type": "media-url",
            "repeatable": true,
            "required": true
          },
          {
            "name": "aspect_ratio",
            "class": "default",
            "flag": "--aspect-ratio",
            "type": "string",
            "default": "9:16",
            "required": false
          },
          {
            "name": "resolution",
            "class": "default",
            "flag": "--resolution",
            "type": "string",
            "enumValues": [
              "2k"
            ],
            "default": "2k",
            "required": false
          },
          {
            "name": "output_format",
            "class": "default",
            "flag": "--output-format",
            "type": "string",
            "default": "png",
            "required": false
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
          "imageSize"
        ]
      },
      {
        "endpointKey": "image-nano-banana-pro-edit-4k",
        "provider": "wavespeed",
        "providerModelPath": "google/nano-banana-pro/edit",
        "fields": [
          {
            "name": "prompt",
            "class": "intent",
            "flag": "--prompt",
            "type": "string",
            "required": true
          },
          {
            "name": "images",
            "class": "intent",
            "flag": "--reference-image",
            "type": "media-url",
            "repeatable": true,
            "required": true
          },
          {
            "name": "aspect_ratio",
            "class": "default",
            "flag": "--aspect-ratio",
            "type": "string",
            "default": "9:16",
            "required": false
          },
          {
            "name": "resolution",
            "class": "default",
            "flag": "--resolution",
            "type": "string",
            "enumValues": [
              "4k"
            ],
            "default": "4k",
            "required": false
          },
          {
            "name": "output_format",
            "class": "default",
            "flag": "--output-format",
            "type": "string",
            "default": "png",
            "required": false
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
          "imageSize"
        ]
      },
      {
        "endpointKey": "image-seedream-v5-lite-text",
        "provider": "wavespeed",
        "providerModelPath": "bytedance/seedream-v5.0-lite",
        "fields": [
          {
            "name": "prompt",
            "class": "intent",
            "flag": "--prompt",
            "type": "string",
            "required": true
          },
          {
            "name": "size",
            "class": "default",
            "flag": "--size",
            "type": "string",
            "default": "1440*2560",
            "required": false
          },
          {
            "name": "output_format",
            "class": "default",
            "flag": "--output-format",
            "type": "string",
            "default": "png",
            "required": false
          },
          {
            "name": "max_images",
            "class": "intent",
            "flag": "--max-images",
            "type": "number",
            "required": false
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
          "billableUnitCount"
        ]
      },
      {
        "endpointKey": "image-seedream-v5-lite-sequential",
        "provider": "wavespeed",
        "providerModelPath": "bytedance/seedream-v5.0-lite/sequential",
        "fields": [
          {
            "name": "prompt",
            "class": "intent",
            "flag": "--prompt",
            "type": "string",
            "required": true
          },
          {
            "name": "size",
            "class": "default",
            "flag": "--size",
            "type": "string",
            "default": "1440*2560",
            "required": false
          },
          {
            "name": "output_format",
            "class": "default",
            "flag": "--output-format",
            "type": "string",
            "default": "png",
            "required": false
          },
          {
            "name": "max_images",
            "class": "intent",
            "flag": "--max-images",
            "type": "number",
            "required": false
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
          "billableUnitCount"
        ]
      },
      {
        "endpointKey": "image-seedream-v5-lite-edit",
        "provider": "wavespeed",
        "providerModelPath": "bytedance/seedream-v5.0-lite/edit",
        "fields": [
          {
            "name": "prompt",
            "class": "intent",
            "flag": "--prompt",
            "type": "string",
            "required": true
          },
          {
            "name": "images",
            "class": "intent",
            "flag": "--reference-image",
            "type": "media-url",
            "repeatable": true,
            "required": true
          },
          {
            "name": "size",
            "class": "default",
            "flag": "--size",
            "type": "string",
            "default": "1440*2560",
            "required": false
          },
          {
            "name": "output_format",
            "class": "default",
            "flag": "--output-format",
            "type": "string",
            "default": "png",
            "required": false
          },
          {
            "name": "max_images",
            "class": "intent",
            "flag": "--max-images",
            "type": "number",
            "required": false
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
          "billableUnitCount"
        ]
      },
      {
        "endpointKey": "image-seedream-v5-lite-edit-sequential",
        "provider": "wavespeed",
        "providerModelPath": "bytedance/seedream-v5.0-lite/edit-sequential",
        "fields": [
          {
            "name": "prompt",
            "class": "intent",
            "flag": "--prompt",
            "type": "string",
            "required": true
          },
          {
            "name": "images",
            "class": "intent",
            "flag": "--reference-image",
            "type": "media-url",
            "repeatable": true,
            "required": true
          },
          {
            "name": "size",
            "class": "default",
            "flag": "--size",
            "type": "string",
            "default": "1440*2560",
            "required": false
          },
          {
            "name": "output_format",
            "class": "default",
            "flag": "--output-format",
            "type": "string",
            "default": "png",
            "required": false
          },
          {
            "name": "max_images",
            "class": "intent",
            "flag": "--max-images",
            "type": "number",
            "required": false
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
          "billableUnitCount"
        ]
      }
    ]
  },
  "seedance-submitter": {
    "skill": "seedance-submitter",
    "mode": "cli-runner",
    "surface": "request-json",
    "verb": "create",
    "domain": "media",
    "capability": "media-generation",
    "endpointKeys": [
      "video-seedance-2-image",
      "video-seedance-2-image-turbo",
      "video-seedance-2-text",
      "video-seedance-2-text-turbo"
    ],
    "endpoints": [
      {
        "endpointKey": "video-seedance-2-image",
        "provider": "wavespeed",
        "providerModelPath": "bytedance/seedance-2.0/image-to-video",
        "fields": [
          {
            "name": "prompt",
            "class": "intent",
            "flag": null,
            "type": "string",
            "required": true
          },
          {
            "name": "image",
            "class": "intent",
            "flag": null,
            "type": "media-url",
            "required": true
          },
          {
            "name": "resolution",
            "class": "default",
            "flag": null,
            "type": "string",
            "enumValues": [
              "480p",
              "720p",
              "1080p"
            ],
            "default": "720p",
            "required": false
          },
          {
            "name": "duration",
            "class": "default",
            "flag": null,
            "type": "number",
            "default": 5,
            "required": false,
            "min": 4,
            "max": 15
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
          },
          {
            "name": "requestDimensions",
            "class": "runner-managed",
            "flag": null,
            "type": "string",
            "required": false
          }
        ],
        "billingDimensions": [
          "duration",
          "resolution",
          "referenceVideoCount",
          "referenceVideoMode"
        ]
      },
      {
        "endpointKey": "video-seedance-2-image-turbo",
        "provider": "wavespeed",
        "providerModelPath": "bytedance/seedance-2.0/image-to-video-turbo",
        "fields": [
          {
            "name": "prompt",
            "class": "intent",
            "flag": null,
            "type": "string",
            "required": true
          },
          {
            "name": "image",
            "class": "intent",
            "flag": null,
            "type": "media-url",
            "required": true
          },
          {
            "name": "resolution",
            "class": "default",
            "flag": null,
            "type": "string",
            "enumValues": [
              "480p",
              "720p",
              "1080p"
            ],
            "default": "720p",
            "required": false
          },
          {
            "name": "duration",
            "class": "default",
            "flag": null,
            "type": "number",
            "default": 5,
            "required": false,
            "min": 4,
            "max": 15
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
          },
          {
            "name": "requestDimensions",
            "class": "runner-managed",
            "flag": null,
            "type": "string",
            "required": false
          }
        ],
        "billingDimensions": [
          "duration",
          "resolution",
          "referenceVideoCount",
          "referenceVideoMode"
        ]
      },
      {
        "endpointKey": "video-seedance-2-text",
        "provider": "wavespeed",
        "providerModelPath": "bytedance/seedance-2.0/text-to-video",
        "fields": [
          {
            "name": "prompt",
            "class": "intent",
            "flag": null,
            "type": "string",
            "required": true
          },
          {
            "name": "resolution",
            "class": "default",
            "flag": null,
            "type": "string",
            "enumValues": [
              "480p",
              "720p",
              "1080p"
            ],
            "default": "720p",
            "required": false
          },
          {
            "name": "aspect_ratio",
            "class": "intent",
            "flag": null,
            "type": "string",
            "enumValues": [
              "21:9",
              "16:9",
              "4:3",
              "1:1",
              "3:4",
              "9:16"
            ],
            "required": false
          },
          {
            "name": "duration",
            "class": "default",
            "flag": null,
            "type": "number",
            "default": 5,
            "required": false,
            "min": 4,
            "max": 15
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
          },
          {
            "name": "requestDimensions",
            "class": "runner-managed",
            "flag": null,
            "type": "string",
            "required": false
          }
        ],
        "billingDimensions": [
          "duration",
          "resolution",
          "referenceVideoCount",
          "referenceVideoMode"
        ]
      },
      {
        "endpointKey": "video-seedance-2-text-turbo",
        "provider": "wavespeed",
        "providerModelPath": "bytedance/seedance-2.0/text-to-video-turbo",
        "fields": [
          {
            "name": "prompt",
            "class": "intent",
            "flag": null,
            "type": "string",
            "required": true
          },
          {
            "name": "resolution",
            "class": "default",
            "flag": null,
            "type": "string",
            "enumValues": [
              "480p",
              "720p",
              "1080p"
            ],
            "default": "720p",
            "required": false
          },
          {
            "name": "aspect_ratio",
            "class": "intent",
            "flag": null,
            "type": "string",
            "enumValues": [
              "21:9",
              "16:9",
              "4:3",
              "1:1",
              "3:4",
              "9:16"
            ],
            "required": false
          },
          {
            "name": "duration",
            "class": "default",
            "flag": null,
            "type": "number",
            "default": 5,
            "required": false,
            "min": 4,
            "max": 15
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
          },
          {
            "name": "requestDimensions",
            "class": "runner-managed",
            "flag": null,
            "type": "string",
            "required": false
          }
        ],
        "billingDimensions": [
          "duration",
          "resolution",
          "referenceVideoCount",
          "referenceVideoMode"
        ]
      }
    ]
  }
} as const;
