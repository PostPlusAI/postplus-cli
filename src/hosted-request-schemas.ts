type HostedSchemaDomain = 'media' | 'mobile' | 'publish' | 'research';

type HostedRequestSchemaReport = {
  schemaVersion: 1;
  domain: HostedSchemaDomain;
  command: string;
  description: string;
  endpointKeys?: string[];
  selectedEndpointKey?: string;
  notes: string[];
  schemas: Array<{
    id: string;
    description: string;
    required: string[];
    jsonSchema: Record<string, unknown>;
  }>;
  examples: Record<string, unknown>;
};

const JSON_OBJECT_SCHEMA = {
  additionalProperties: true,
  type: 'object',
} as const;

const OPERATION_ID_SCHEMA = {
  description: 'Stable idempotency key for this logical operation.',
  minLength: 1,
  type: 'string',
} as const;

const MEDIA_ENDPOINT_HINTS: Record<string, Record<string, unknown>> = {
  'transcription-whisper': {
    audio: 'https://example.com/input-audio.mp3',
    language: 'en',
    response_format: 'verbose_json',
    timestamp_granularities: ['segment'],
  },
  'transcription-whisper-turbo': {
    audio: 'https://example.com/input-audio.mp3',
    language: 'en',
    response_format: 'verbose_json',
    timestamp_granularities: ['segment'],
  },
  'transcription-whisper-with-video': {
    language: 'en',
    response_format: 'verbose_json',
    timestamp_granularities: ['segment'],
    video: 'https://example.com/input-video.mp4',
  },
  'video-infinitetalk': {
    audio: 'https://example.com/voiceover.wav',
    image: 'https://example.com/persona.png',
    prompt: 'Talking-head delivery in a natural vertical social ad style.',
  },
  'video-kling-v2-6-pro-motion-control': {
    character_orientation: 'image',
    image: 'https://example.com/subject.png',
    video: 'https://example.com/reference-motion.mp4',
  },
  'video-kling-v3-0-pro-image': {
    duration: 5,
    image: 'https://example.com/start-frame.png',
    prompt: 'Animate the product in a clean realistic vertical scene.',
    sound: false,
  },
  'video-kling-v3-0-pro-text': {
    aspect_ratio: '9:16',
    duration: 5,
    prompt: 'A realistic vertical short-form product reveal.',
    sound: false,
  },
  'video-kling-v3-0-std-image': {
    duration: 5,
    image: 'https://example.com/start-frame.png',
    prompt: 'Animate the product in a clean realistic vertical scene.',
    sound: false,
  },
  'video-kling-v3-0-std-text': {
    aspect_ratio: '9:16',
    duration: 5,
    prompt: 'A realistic vertical short-form product reveal.',
    sound: false,
  },
  'video-seedance-2-image': {
    duration: 5,
    image: 'https://example.com/start-frame.png',
    prompt: 'A realistic vertical short-form product reveal.',
    resolution: '720p',
  },
  'video-seedance-2-image-turbo': {
    duration: 5,
    image: 'https://example.com/start-frame.png',
    prompt: 'A realistic vertical short-form product reveal.',
    resolution: '720p',
  },
  'video-seedance-2-text': {
    duration: 5,
    prompt: 'A realistic vertical short-form product reveal.',
    resolution: '720p',
  },
  'video-seedance-2-text-turbo': {
    duration: 5,
    prompt: 'A realistic vertical short-form product reveal.',
    resolution: '720p',
  },
  'voice-qwen3-clone': {
    reference_audio: 'https://example.com/reference-voice.wav',
    text: 'Short voiceover line to synthesize.',
  },
  'voice-qwen3-design': {
    language: 'en',
    text: 'Short voiceover line to synthesize.',
    voiceDescription: 'Warm, clear, natural creator voice.',
  },
};

export function buildHostedRequestSchemaReport(input: {
  domain: HostedSchemaDomain;
  endpointKey?: string | null;
}): HostedRequestSchemaReport {
  switch (input.domain) {
    case 'research':
      return buildResearchSchemaReport();
    case 'media':
      return buildMediaSchemaReport(input.endpointKey ?? null);
    case 'publish':
      return buildPublishSchemaReport();
    case 'mobile':
      return buildMobileSchemaReport();
  }
}

function buildResearchSchemaReport(): HostedRequestSchemaReport {
  return {
    schemaVersion: 1,
    domain: 'research',
    command:
      'postplus research collect --skill <skill-id> --collection-key <key> --input <hosted-envelope.json> --output <result.json>',
    description:
      'Schema for the file passed to postplus research collect --input.',
    notes: [
      'The collection key stays in the CLI flag, not inside the JSON file.',
      'Put the skill-specific provider input under input.',
      'Use --run-handle for polling instead of this envelope.',
    ],
    schemas: [
      {
        id: 'research.collection-envelope',
        description: 'Hosted research collection input envelope.',
        required: ['schemaVersion', 'input'],
        jsonSchema: {
          additionalProperties: false,
          properties: {
            hostedOperationId: OPERATION_ID_SCHEMA,
            input: JSON_OBJECT_SCHEMA,
            operationId: OPERATION_ID_SCHEMA,
            quoteConfirmationToken: {
              minLength: 1,
              type: 'string',
            },
            schemaVersion: {
              const: 1,
            },
          },
          required: ['schemaVersion', 'input'],
          type: 'object',
        },
      },
    ],
    examples: {
      'research.collection-envelope': {
        schemaVersion: 1,
        input: {
          maxItems: 20,
          query: 'electric toothbrush morning routine',
        },
      },
    },
  };
}

function buildMediaSchemaReport(
  endpointKey: string | null,
): HostedRequestSchemaReport {
  if (endpointKey && !MEDIA_ENDPOINT_HINTS[endpointKey]) {
    throw new Error(
      `Unknown media endpoint ${endpointKey}. Known endpoints: ${Object.keys(
        MEDIA_ENDPOINT_HINTS,
      ).join(', ')}`,
    );
  }

  const endpointInput = endpointKey
    ? MEDIA_ENDPOINT_HINTS[endpointKey]
    : {
        prompt: 'A realistic vertical short-form product reveal.',
      };
  const selectedEndpoint = endpointKey ?? '<endpoint-key>';

  return {
    schemaVersion: 1,
    domain: 'media',
    command:
      'postplus media capability --request <hosted-capability-request.json> --output <result.json>',
    description:
      'Schemas for files passed to postplus media capability --request.',
    endpointKeys: Object.keys(MEDIA_ENDPOINT_HINTS).sort(),
    selectedEndpointKey: endpointKey ?? undefined,
    notes: [
      'Use media-generation request for async generation, transcription, and voice jobs.',
      'Use media-generation status with the output.data.id handle returned by a pending request.',
      'Use media-file operations for upload/download setup when a workflow needs hosted media storage.',
      'Endpoint-specific input belongs under input; top-level provider or billing fields are not public contract fields.',
    ],
    schemas: [
      {
        id: 'media-generation.request',
        description: 'Submit an async media generation/transcription job.',
        required: [
          'capability',
          'operation',
          'operationId',
          'endpointKey',
          'input',
          'requestDimensions',
        ],
        jsonSchema: {
          additionalProperties: false,
          properties: {
            capability: { const: 'media-generation' },
            endpointKey: {
              minLength: 1,
              type: 'string',
            },
            input: JSON_OBJECT_SCHEMA,
            operation: { const: 'request' },
            operationId: OPERATION_ID_SCHEMA,
            quoteConfirmationToken: {
              minLength: 1,
              type: 'string',
            },
            requestDimensions: JSON_OBJECT_SCHEMA,
            skillName: {
              minLength: 1,
              type: 'string',
            },
          },
          required: [
            'capability',
            'operation',
            'operationId',
            'endpointKey',
            'input',
            'requestDimensions',
          ],
          type: 'object',
        },
      },
      {
        id: 'media-generation.status',
        description: 'Poll an async media generation/transcription job.',
        required: ['capability', 'operation', 'operationId', 'handle'],
        jsonSchema: {
          additionalProperties: false,
          properties: {
            capability: { const: 'media-generation' },
            handle: {
              minLength: 1,
              type: 'string',
            },
            operation: { const: 'status' },
            operationId: OPERATION_ID_SCHEMA,
            skillName: {
              minLength: 1,
              type: 'string',
            },
          },
          required: ['capability', 'operation', 'operationId', 'handle'],
          type: 'object',
        },
      },
      {
        id: 'media-file.create-upload-url',
        description: 'Create a hosted media upload target.',
        required: ['capability', 'operation', 'operationId', 'file'],
        jsonSchema: {
          additionalProperties: false,
          properties: {
            capability: { const: 'media-file' },
            file: {
              additionalProperties: false,
              properties: {
                mimeType: { minLength: 1, type: 'string' },
                name: { minLength: 1, type: 'string' },
                sizeBytes: { minimum: 1, type: 'integer' },
              },
              required: ['mimeType', 'name', 'sizeBytes'],
              type: 'object',
            },
            operation: { const: 'create-upload-url' },
            operationId: OPERATION_ID_SCHEMA,
            quoteConfirmationToken: {
              minLength: 1,
              type: 'string',
            },
          },
          required: ['capability', 'operation', 'operationId', 'file'],
          type: 'object',
        },
      },
    ],
    examples: {
      'media-generation.request': {
        skillName: 'video-batch-runner',
        capability: 'media-generation',
        operation: 'request',
        operationId: `media-generation:${selectedEndpoint}:demo`,
        endpointKey: selectedEndpoint,
        input: endpointInput,
        requestDimensions: {
          billableUnitCount: 1,
          operationKey: selectedEndpoint,
        },
      },
      'media-generation.status': {
        skillName: 'video-batch-runner',
        capability: 'media-generation',
        operation: 'status',
        operationId: 'media-generation:status:demo',
        handle: '<output.data.id>',
      },
      'media-file.create-upload-url': {
        capability: 'media-file',
        operation: 'create-upload-url',
        operationId: 'media-file:create-upload-url:demo',
        file: {
          mimeType: 'video/mp4',
          name: 'input.mp4',
          sizeBytes: 1048576,
        },
      },
    },
  };
}

function buildPublishSchemaReport(): HostedRequestSchemaReport {
  return {
    schemaVersion: 1,
    domain: 'publish',
    command:
      'postplus publish capability --request <hosted-capability-request.json> --output <result.json>',
    description:
      'Schema for files passed to postplus publish capability --request.',
    notes: [
      'Use social-publishing operations only through PostPlus Cloud.',
      'Put the operation-specific publishing payload under input.',
    ],
    schemas: [
      {
        id: 'social-publishing.request',
        description: 'Run a hosted social publishing operation.',
        required: ['capability', 'operation', 'operationId', 'input'],
        jsonSchema: {
          additionalProperties: false,
          properties: {
            capability: { const: 'social-publishing' },
            input: JSON_OBJECT_SCHEMA,
            operation: {
              enum: [
                'analytics',
                'channel-settings',
                'create-post',
                'delete-post',
                'delete-post-group',
                'list-channels',
                'list-posts',
                'missing-content',
                'notifications',
                'set-release-id',
                'trigger-channel-tool',
                'update-post-status',
                'upload-file',
                'upload-from-url',
              ],
              type: 'string',
            },
            operationId: OPERATION_ID_SCHEMA,
            quoteConfirmationToken: {
              minLength: 1,
              type: 'string',
            },
            skillName: {
              minLength: 1,
              type: 'string',
            },
          },
          required: ['capability', 'operation', 'operationId', 'input'],
          type: 'object',
        },
      },
    ],
    examples: {
      'social-publishing.list-channels': {
        skillName: 'social-media-publisher',
        capability: 'social-publishing',
        operation: 'list-channels',
        operationId: 'social-publishing:list-channels:demo',
        input: {},
      },
    },
  };
}

function buildMobileSchemaReport(): HostedRequestSchemaReport {
  return {
    schemaVersion: 1,
    domain: 'mobile',
    command:
      'postplus mobile capability --request <hosted-capability-request.json> --output <result.json>',
    description:
      'Schema for files passed to postplus mobile capability --request.',
    notes: [
      'Use mobile-automation operations only through PostPlus Cloud.',
      'Put the operation-specific mobile automation payload under input.',
    ],
    schemas: [
      {
        id: 'mobile-automation.request',
        description: 'Run a hosted mobile automation operation.',
        required: ['capability', 'operation', 'operationId', 'input'],
        jsonSchema: {
          additionalProperties: false,
          properties: {
            capability: { const: 'mobile-automation' },
            input: JSON_OBJECT_SCHEMA,
            operation: {
              enum: [
                'cancel-tasks',
                'create-cloud-phones',
                'install-app',
                'list-cloud-phones',
                'list-installed-apps',
                'list-installable-apps',
                'query-phone-status',
                'query-tasks',
                'start-app',
                'start-cloud-phones',
                'stop-cloud-phones',
                'task-detail',
                'tiktok-login',
                'tiktok-publish-image-set',
                'tiktok-publish-video',
                'tiktok-warmup',
                'uninstall-app',
              ],
              type: 'string',
            },
            operationId: OPERATION_ID_SCHEMA,
            quoteConfirmationToken: {
              minLength: 1,
              type: 'string',
            },
            skillName: {
              minLength: 1,
              type: 'string',
            },
          },
          required: ['capability', 'operation', 'operationId', 'input'],
          type: 'object',
        },
      },
    ],
    examples: {
      'mobile-automation.list-cloud-phones': {
        skillName: 'geelark-mobile-automation',
        capability: 'mobile-automation',
        operation: 'list-cloud-phones',
        operationId: 'mobile-automation:list-cloud-phones:demo',
        input: {},
      },
    },
  };
}
