/**
 * TrustMesh Core Constants and Enums
 * Pure JavaScript module for multi-agent AI verification
 */

export const INSURANCE_TYPES = [
  'Motor Insurance',
  'Health Insurance',
  'Commercial Property',
  'Homeowners Insurance',
  'Travel Insurance',
  'Marine Cargo',
];

export const POLICY_STATUSES = ['Active', 'Expired', 'Suspended', 'Pending Renewal'];

export const CLAIM_STATUSES = [
  'Under Review',
  'Submitted',
  'Verified',
  'Approved',
  'Rejected',
  'Human Review Required',
];

export const AGENT_IDS = ['agent_a', 'agent_b', 'agent_c', 'agent_d', 'agent_e'];

export const HANDOFF_IDS = ['A_TO_B', 'B_TO_C', 'C_TO_D', 'D_TO_E'];

export const ERROR_CATEGORIES = [
  'DATA_LOSS',
  'DATA_MANIPULATION',
  'DATA_CORRUPTION',
  'SEMANTIC_INCONSISTENCY',
  'INCORRECT_CALCULATIONS',
  'DUPLICATE_OR_REPLAY',
  'UNAUTHORIZED_TRANSFORMATION',
  'STALE_OUT_OF_ORDER',
  'PARTIAL_FAILED_HANDOFF',
  'MISLEADING_OUTPUT',
  'UNAUTHORIZED_ACCESS',
  'CLEAN_VERIFIED',
];

export const SEVERITIES = ['info', 'warning', 'high', 'critical'];

export const VERIFICATION_STATUSES = [
  'VERIFIED',
  'WARNING',
  'BLOCKED',
  'RECOVERY',
  'HUMAN_REVIEW',
  'NOT_RUN',
];
