// 故事相关类型定义

// === 新增类型 (C1: 1.1-1.4, 1.9) ===

export type CharacterRole = 'protagonist' | 'supporting' | 'antagonist' | 'narrator';

export type CharacterRelationship = {
  targetId: string;
  relation: string;
  strength: number; // 0-1
};

export type CharacterStateEntry = {
  segmentId: string;
  state: string;
};

export type Character = {
  id: string;
  name: string;
  era: string;
  role: CharacterRole;
  traits: string[];
  speechPatterns: string;
  relationships: CharacterRelationship[];
  stateHistory: CharacterStateEntry[];
  coreMotivation: string;
  createdAt?: string;
  updatedAt?: string;
};

export type TimelineEvent = {
  era: string;
  year: number;
  season?: string;
  description: string;
  narrativeTime: string;
};

// === 叙事状态追踪 (Narrative State Tracker) ===
export type NarrativeObjectType = 'character' | 'location' | 'faction' | 'item' | 'relationship' | 'event';

export type StateProperty = {
  key: string;
  value: string;
  updatedAt: string;
};

export type NarrativeStateEntry = {
  id: string;
  type: NarrativeObjectType;
  name: string;
  branchId: string;
  properties: Record<string, string>;
  history: Array<{
    segmentId: string;
    changedProperties: Record<string, string>;
    previousValues: Record<string, string>;
  }>;
  lastSeenSegmentId: string;
  createdAt: string;
  updatedAt: string;
};

// === 知识图谱 (Knowledge Graph) ===
export type GraphNodeType = 'character' | 'event' | 'location' | 'branch_point' | 'faction';

export type GraphEdgeType =
  | 'causes' | 'leads_to' | 'located_at' | 'involves'
  | 'conflicts_with' | 'ally_of' | 'belongs_to' | 'precedes' | 'parallel_to';

export type KnowledgeNode = {
  id: string;
  type: GraphNodeType;
  name: string;
  branchId: string;
  properties: Record<string, string>;
  segmentIds: string[];
  createdAt: string;
  updatedAt: string;
};

export type KnowledgeEdge = {
  id: string;
  source: string;
  target: string;
  type: GraphEdgeType;
  branchId: string;
  properties: Record<string, string>;
  segmentId: string;
  createdAt: string;
};

// === 现有类型 (向后兼容) ===

export type HistoricalEntityType = 'person' | 'event' | 'place' | 'artifact';

export type HistoricalReference = {
  id?: string;
  entityType: HistoricalEntityType;
  name: string;
  wikiUrl?: string;
  wikiSummary?: string;
  confidence: number; // 0-1
  verifiedAt?: string;
};

export type PacingPace = 'rush' | 'detailed' | 'pause' | 'summary';

export type PacingConfig = {
  pace: PacingPace;
  mood?: string;
  estimatedReadMinutes?: number;
  maxLinesPerStep?: number;
};

export type DirectorState = {
  id?: string;
  storyId: string;
  characterStates: Record<string, string>; // characterId -> state description
  worldVariables: Record<string, string>; // key -> value
  activeConstraints: string[];
  updatedAt?: string;
};

// === 现有类型 (向后兼容) ===

export type Story = {
  id: string;
  title: string;
  description?: string;
  author?: string;
  createdAt: string;
  updatedAt: string;
  rootSegmentId?: string;
  // C1: 1.6 扩展
  era?: string;
  genre?: string;
  storyType?: string;
  characterIds?: string[];
  // Social
  ownerId?: string;
  visibility?: 'PRIVATE' | 'PUBLIC' | 'UNLISTED';
  likeCount?: number;
  commentCount?: number;
  forkCount?: number;
};

export type StorySegment = {
  id: string;
  title?: string;
  content: string;
  isBranchPoint: boolean;
  createdAt: string;
  updatedAt: string;
  storyId: string;
  branchId: string;
  parentSegmentId?: string;
  imageUrls: string[];
  imagePrompts?: string[];
  imageStyle?: string;
  // C1: 1.5 扩展
  timeline?: TimelineEvent;
  characterIds?: string[];
  historicalReferences?: HistoricalReference[];
  narrativePace?: PacingPace;
  mood?: string;
};

export type StoryBranch = {
  id: string;
  title: string;
  description?: string;
  sourceSegmentId: string;
  storyId: string;
  userDirection: string;
  createdAt: string;
  updatedAt: string;
  // C1: 1.7 扩展
  characterStateSnapshot?: Record<string, string>;
  forkTimeline?: TimelineEvent;
  // Social: fork tracking
  model?: string;
  ownerId?: string;
  visibility?: 'PRIVATE' | 'PUBLIC' | 'UNLISTED';
  ownerName?: string;
  likeCount?: number;
  commentCount?: number;
};

// === 社交功能类型 ===

export type CommentData = {
  id: string;
  content: string;
  createdAt: string;
  updatedAt: string;
  userId: string;
  storyId?: string;
  branchId?: string;
  parentId?: string;
  user: { id: string; name: string; image?: string };
  _count?: { likes: number };
  liked?: boolean;
  replies?: CommentData[];
};

export type StoryLikeData = {
  id: string;
  userId: string;
  storyId?: string;
  branchId?: string;
  createdAt: string;
  user?: { id: string; name: string; image?: string };
};

// API 请求/响应类型
export type ContinueStoryRequest = {
  segmentId: string;
  branchId: string;
  content?: string;
  style?: string;
  characters?: string[];
  // C1: 1.8 扩展
  pacingConfig?: PacingConfig;
  directorOverrides?: Partial<DirectorState>;
};

export type BranchStoryRequest = {
  segmentId: string;
  userDirection: string;
  branchTitle?: string;
};

export type StoryResponse = {
  segments: StorySegment[];
  branches: StoryBranch[];
  currentSegment: StorySegment;
};

// UI 组件类型
export type TreeNode = {
  id: string;
  title?: string;
  content?: string;
  isBranchPoint: boolean;
  children: TreeNode[];
  branchId: string;
  branchTitle?: string;
  parentSegmentId?: string;
};

// 向后兼容的类实现
class StoryClass {
  id!: string;
  title!: string;
  description?: string;
  author?: string;
  createdAt!: string;
  updatedAt!: string;
  rootSegmentId?: string;
  era?: string;
  genre?: string;
  storyType?: string;
  characterIds?: string[];
  constructor(data: Story) { Object.assign(this, data); }
}

class StorySegmentClass {
  id!: string;
  title?: string;
  content!: string;
  isBranchPoint!: boolean;
  createdAt!: string;
  updatedAt!: string;
  storyId!: string;
  branchId!: string;
  parentSegmentId!: string;
  imageUrls!: string[];
  imagePrompts?: string[];
  imageStyle?: string;
  timeline?: TimelineEvent;
  characterIds?: string[];
  historicalReferences?: HistoricalReference[];
  narrativePace?: PacingPace;
  mood?: string;
  constructor(data: StorySegment) { Object.assign(this, data); }
}

class StoryBranchClass {
  id!: string;
  title!: string;
  description?: string;
  sourceSegmentId!: string;
  storyId!: string;
  userDirection!: string;
  createdAt!: string;
  updatedAt!: string;
  characterStateSnapshot?: Record<string, string>;
  forkTimeline?: TimelineEvent;
  constructor(data: StoryBranch) { Object.assign(this, data); }
}

module.exports = {
  Story: StoryClass,
  StorySegment: StorySegmentClass,
  StoryBranch: StoryBranchClass
};
