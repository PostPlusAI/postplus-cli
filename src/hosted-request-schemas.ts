import { Buffer } from 'node:buffer';

type HostedSchemaDomain = 'media' | 'mobile' | 'publish' | 'research';

type HostedRequestSchemaReport = {
  schemaVersion: 1;
  domain: HostedSchemaDomain;
  collectionKeys?: string[];
  command: string;
  description: string;
  endpointKeys?: string[];
  modelKeys?: string[];
  selectedCollectionKey?: string;
  selectedEndpointKey?: string;
  sourceKeys?: string[];
  toolKeys?: string[];
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

const RESEARCH_COLLECTION_HINTS: Record<string, Record<string, unknown>> = {
  'amazon-asins': {
    asins: ['B0C1234567'],
    country: 'US',
  },
  'amazon-bestsellers': {
    categoryUrl: 'https://www.amazon.com/Best-Sellers/zgbs',
    maxItems: 5,
  },
  'amazon-free-products': {
    keyword: 'portable blender',
    maxItems: 5,
  },
  'amazon-products': {
    country: 'US',
    keyword: 'portable blender',
    maxItems: 5,
  },
  'amazon-reviews': {
    asin: 'B0C1234567',
    country: 'US',
    maxReviews: 10,
  },
  'amazon-reviews-v2': {
    asin: 'B0C1234567',
    domainCode: 'com',
    maxReviews: 10,
  },
  'google-trends-fast': {
    queries: ['portable blender'],
  },
  'instagram-comments': {
    directUrls: ['https://www.instagram.com/p/example/'],
    resultsLimit: 5,
  },
  'instagram-email-search': {
    Country: 'www',
    Email_Type: '0',
    Keyword: 'skincare creator',
    Limit: '10',
    social_network: 'instagram.com/',
  },
  'instagram-hashtags': {
    hashtags: ['desksetup'],
    resultsLimit: 3,
  },
  'instagram-posts': {
    resultsLimit: 3,
    username: ['openai'],
  },
  'instagram-profiles': {
    resultsLimit: 3,
    usernames: ['instagram'],
  },
  'instagram-search': {
    searchLimit: 3,
    searchTerms: ['skincare routine'],
    searchType: 'user',
  },
  'tiktok-ads-top': {
    include_analytics: true,
    limit: 1,
  },
  'tiktok-comments': {
    postURLs: ['https://www.tiktok.com/@example/video/1234567890'],
    resultsPerPage: 5,
  },
  'tiktok-profiles': {
    usernames: ['tiktok'],
  },
  'tiktok-related-videos': {
    maxItems: 3,
    postURLs: ['https://www.tiktok.com/@example/video/1234567890'],
  },
  'tiktok-users': {
    maxItems: 5,
    searchQueries: ['skincare creator'],
  },
  'tiktok-videos': {
    maxItems: 3,
    proxyCountryCode: 'US',
    queries: ['portable blender'],
    searchSection: '/video',
  },
  'youtube-channel-summary': {
    channels: ['@Google'],
    includeChannelInfo: true,
    includeVideos: false,
    maxVideosPerChannel: 0,
  },
  'youtube-comments': {
    maxComments: 10,
    startUrls: ['https://www.youtube.com/watch?v=dQw4w9WgXcQ'],
  },
  'youtube-video-download': {
    urls: ['https://www.youtube.com/watch?v=dQw4w9WgXcQ'],
  },
  'x-posts': {
    maxItems: 5,
    searchTerms: ['product launch'],
  },
  'x-profiles': {
    handles: ['OpenAI'],
  },
};

const PUBLIC_CONTENT_SOURCE_HINTS: Record<string, Array<Record<string, unknown>>> = {
  'facebook-group-posts': [
    {
      url: 'https://www.facebook.com/groups/example',
    },
  ],
  'facebook-post-by-url': [
    {
      url: 'https://www.facebook.com/openai/posts/example',
    },
  ],
  'facebook-profile-posts': [
    {
      url: 'https://www.facebook.com/openai',
    },
  ],
  'youtube-videos': [
    {
      url: 'https://www.youtube.com/watch?v=dQw4w9WgXcQ',
    },
  ],
};

const PUBLIC_CONTENT_DISCOVERY_TOOL_HINTS: Record<string, Record<string, unknown>> = {
  'web-search': {
    limit: 5,
    query: 'portable blender reviews',
  },
};

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

const VIDEO_ANALYSIS_MODEL_HINTS: Record<string, Record<string, unknown>> = {
  'gemini-video-analysis': {
    contents: [
      {
        parts: [
          {
            text: 'Analyze this short video and return concise creative observations.',
          },
        ],
      },
    ],
  },
};

export function buildHostedRequestSchemaReport(input: {
  collectionKey?: string | null;
  domain: HostedSchemaDomain;
  endpointKey?: string | null;
}): HostedRequestSchemaReport {
  switch (input.domain) {
    case 'research':
      return buildResearchSchemaReport(input.collectionKey ?? null);
    case 'media':
      return buildMediaSchemaReport(input.endpointKey ?? null);
    case 'publish':
      return buildPublishSchemaReport();
    case 'mobile':
      return buildMobileSchemaReport();
  }
}

function buildResearchSchemaReport(
  collectionKey: string | null,
): HostedRequestSchemaReport {
  if (collectionKey && !RESEARCH_COLLECTION_HINTS[collectionKey]) {
    throw new Error(
      `Unknown research collection ${collectionKey}. Known collections: ${Object.keys(
        RESEARCH_COLLECTION_HINTS,
      ).join(', ')}`,
    );
  }

  const collectionInput = collectionKey
    ? RESEARCH_COLLECTION_HINTS[collectionKey]
    : {
        maxItems: 20,
        query: 'electric toothbrush morning routine',
      };

  return {
    schemaVersion: 1,
    domain: 'research',
    command:
      'postplus research collect --skill <skill-id> --collection-key <key> --input <hosted-envelope.json> --output <result.json>; postplus research capability --request <hosted-capability-request.json> --output <result.json>',
    description:
      'Schemas for files passed to hosted research commands.',
    collectionKeys: Object.keys(RESEARCH_COLLECTION_HINTS).sort(),
    selectedCollectionKey: collectionKey ?? undefined,
    sourceKeys: Object.keys(PUBLIC_CONTENT_SOURCE_HINTS).sort(),
    toolKeys: Object.keys(PUBLIC_CONTENT_DISCOVERY_TOOL_HINTS).sort(),
    notes: [
      'The collection key stays in the CLI flag, not inside the JSON file.',
      'Put the skill-specific provider input under input.',
      'Use --run-handle for polling instead of this envelope.',
      'Use research capability for public-content sourceKey and discovery tool requests.',
      'The CLI derives operationId before sending capability requests to PostPlus Cloud.',
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
      {
        id: 'public-content-collection.scrape',
        description: 'Collect public content from a released sourceKey.',
        required: ['capability', 'operation', 'sourceKey', 'input'],
        jsonSchema: {
          additionalProperties: false,
          properties: {
            capability: { const: 'public-content-collection' },
            input: {
              items: JSON_OBJECT_SCHEMA,
              minItems: 1,
              type: 'array',
            },
            operation: { const: 'scrape' },
            operationId: OPERATION_ID_SCHEMA,
            quoteConfirmationToken: {
              minLength: 1,
              type: 'string',
            },
            sourceKey: {
              enum: Object.keys(PUBLIC_CONTENT_SOURCE_HINTS).sort(),
              type: 'string',
            },
          },
          required: ['capability', 'operation', 'sourceKey', 'input'],
          type: 'object',
        },
      },
      {
        id: 'public-content-collection.status',
        description: 'Poll a public-content collection job.',
        required: ['capability', 'operation', 'handle'],
        jsonSchema: {
          additionalProperties: false,
          properties: {
            capability: { const: 'public-content-collection' },
            handle: {
              minLength: 1,
              type: 'string',
            },
            operation: { const: 'status' },
            operationId: OPERATION_ID_SCHEMA,
          },
          required: ['capability', 'operation', 'handle'],
          type: 'object',
        },
      },
      {
        id: 'public-content-discovery.tool-call',
        description: 'Run a hosted public-content discovery tool.',
        required: ['capability', 'operation', 'toolKey', 'args'],
        jsonSchema: {
          additionalProperties: false,
          properties: {
            args: JSON_OBJECT_SCHEMA,
            capability: { const: 'public-content-discovery' },
            operation: { const: 'tool-call' },
            operationId: OPERATION_ID_SCHEMA,
            quoteConfirmationToken: {
              minLength: 1,
              type: 'string',
            },
            toolKey: {
              enum: Object.keys(PUBLIC_CONTENT_DISCOVERY_TOOL_HINTS).sort(),
              type: 'string',
            },
          },
          required: ['capability', 'operation', 'toolKey', 'args'],
          type: 'object',
        },
      },
    ],
    examples: {
      'research.collection-envelope': {
        schemaVersion: 1,
        input: collectionInput,
      },
      'public-content-collection.scrape': {
        capability: 'public-content-collection',
        operation: 'scrape',
        sourceKey: 'youtube-videos',
        input: PUBLIC_CONTENT_SOURCE_HINTS['youtube-videos'],
      },
      'public-content-collection.status': {
        capability: 'public-content-collection',
        operation: 'status',
        handle: '<output.data.id>',
      },
      'public-content-discovery.tool-call': {
        capability: 'public-content-discovery',
        operation: 'tool-call',
        toolKey: 'web-search',
        args: PUBLIC_CONTENT_DISCOVERY_TOOL_HINTS['web-search'],
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
    modelKeys: Object.keys(VIDEO_ANALYSIS_MODEL_HINTS).sort(),
    selectedEndpointKey: endpointKey ?? undefined,
    notes: [
      'Use media-generation request for async generation, transcription, and voice jobs.',
      'Use media-generation status with the output.data.id handle returned by a pending request.',
      'Use media-file operations for upload/download setup when a workflow needs hosted media storage.',
      'Use video-analysis analyze for Gemini video understanding payloads.',
      'The CLI derives operationId and billing dimensions before sending requests to PostPlus Cloud.',
      'Endpoint-specific input belongs under input; top-level provider or billing fields are not public contract fields.',
    ],
    schemas: [
      {
        id: 'media-generation.request',
        description: 'Submit an async media generation/transcription job.',
        required: [
          'capability',
          'operation',
          'endpointKey',
          'input',
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
          },
          required: [
            'capability',
            'operation',
            'endpointKey',
            'input',
          ],
          type: 'object',
        },
      },
      {
        id: 'media-generation.status',
        description: 'Poll an async media generation/transcription job.',
        required: ['capability', 'operation', 'handle'],
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
          },
          required: ['capability', 'operation', 'handle'],
          type: 'object',
        },
      },
      {
        id: 'media-file.create-upload-url',
        description: 'Create a hosted media upload target.',
        required: ['capability', 'operation', 'file'],
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
          required: ['capability', 'operation', 'file'],
          type: 'object',
        },
      },
      {
        id: 'video-analysis.analyze',
        description: 'Run hosted Gemini video analysis.',
        required: ['capability', 'operation', 'modelKey', 'payload'],
        jsonSchema: {
          additionalProperties: false,
          properties: {
            capability: { const: 'video-analysis' },
            estimatedUsage: JSON_OBJECT_SCHEMA,
            modelKey: {
              enum: Object.keys(VIDEO_ANALYSIS_MODEL_HINTS).sort(),
              type: 'string',
            },
            operation: { const: 'analyze' },
            operationId: OPERATION_ID_SCHEMA,
            payload: JSON_OBJECT_SCHEMA,
            quoteConfirmationToken: {
              minLength: 1,
              type: 'string',
            },
          },
          required: ['capability', 'operation', 'modelKey', 'payload'],
          type: 'object',
        },
      },
    ],
    examples: {
      'media-generation.request': {
        capability: 'media-generation',
        operation: 'request',
        endpointKey: selectedEndpoint,
        input: endpointInput,
      },
      'media-generation.status': {
        capability: 'media-generation',
        operation: 'status',
        handle: '<output.data.id>',
      },
      'media-file.create-upload-url': {
        capability: 'media-file',
        operation: 'create-upload-url',
        file: {
          mimeType: 'video/mp4',
          name: 'input.mp4',
          sizeBytes: 1048576,
        },
      },
      'video-analysis.analyze': {
        capability: 'video-analysis',
        operation: 'analyze',
        modelKey: 'gemini-video-analysis',
        payload: VIDEO_ANALYSIS_MODEL_HINTS['gemini-video-analysis'],
      },
    },
  };
}

export function buildMediaGenerationRequestDimensions(
  endpointKey: string,
  input: Record<string, unknown>,
): Record<string, unknown> {
  const dimensions: Record<string, unknown> = {
    billableUnitCount: 1,
    operationKey: endpointKey,
  };

  if (endpointKey.startsWith('video-')) {
    const duration = readPositiveNumber(input.duration) ?? 5;
    const resolution =
      typeof input.resolution === 'string' && input.resolution.trim()
        ? input.resolution.trim()
        : '720p';

    dimensions.audioMode =
      endpointKey.startsWith('video-kling-v3-0-') && input.sound !== true
        ? 'off'
        : 'on';
    dimensions.duration = Math.ceil(duration);
    dimensions.requestBytes = Buffer.byteLength(JSON.stringify(input));
    dimensions.resolution = resolution;

    if (endpointKey.startsWith('video-seedance-2-')) {
      const referenceVideoCount = Array.isArray(input.reference_videos)
        ? input.reference_videos.length
        : 0;
      dimensions.referenceVideoCount = referenceVideoCount;
      dimensions.referenceVideoMode =
        referenceVideoCount > 0
          ? 'with_reference_videos'
          : 'without_reference_videos';
    }

    if (endpointKey === 'video-kling-v2-6-pro-motion-control') {
      dimensions.characterOrientation =
        typeof input.character_orientation === 'string'
          ? input.character_orientation
          : 'image';
      dimensions.motionControlMode = 'reference_motion_transfer';
    }
  }

  return dimensions;
}

function readPositiveNumber(value: unknown): number | null {
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) {
    return null;
  }

  return value;
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
        required: ['capability', 'operation', 'input'],
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
          },
          required: ['capability', 'operation', 'input'],
          type: 'object',
        },
      },
    ],
    examples: {
      'social-publishing.list-channels': {
        capability: 'social-publishing',
        operation: 'list-channels',
        input: {},
      },
      'social-publishing.create-post': {
        capability: 'social-publishing',
        operation: 'create-post',
        input: {
          body: {
            posts: [],
          },
        },
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
        required: ['capability', 'operation', 'input'],
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
          },
          required: ['capability', 'operation', 'input'],
          type: 'object',
        },
      },
    ],
    examples: {
      'mobile-automation.list-cloud-phones': {
        capability: 'mobile-automation',
        operation: 'list-cloud-phones',
        input: {},
      },
    },
  };
}
