export type FileSorterItemStatus =
  | 'pending_review'
  | 'approved'
  | 'saved'
  | 'needs_attention'
  | 'ignored'
  | 'failed';

/** Case record sourced from case_slack_channels (+ computed Dropbox path). */
export interface Case {
  /** Same as case_number — used as identifier throughout the app */
  id: string;
  case_number: string;
  slack_channel_name: string;
  slack_channel_id: string | null;
  topic_stage: string | null;
  dropbox_root_path: string;
  dropbox_folder_name: string | null;
}

export interface CaseSlackChannel {
  case_number: string;
  slack_channel_id: string | null;
  slack_channel_name: string;
  dropbox_folder_name: string | null;
  topic_stage: string | null;
  synced_at: string;
  updated_at: string;
}

export interface CaseFolder {
  id: string;
  case_number: string;
  folder_label: string;
  dropbox_path: string;
  created_at: string;
}

export interface FileSorterItem {
  id: string;
  gmail_message_id: string;
  from_email: string;
  to_emails: string[];
  cc_emails: string[];
  subject: string | null;
  body_excerpt: string | null;
  attachment_filename: string;
  attachment_mime_type: string | null;
  attachment_size: number | null;
  temp_storage_url: string | null;
  suggested_case_number: string | null;
  suggested_folder_path: string | null;
  suggested_document_type: string | null;
  ai_confidence: number | null;
  ai_reason: string | null;
  status: FileSorterItemStatus;
  final_case_number: string | null;
  final_dropbox_path: string | null;
  dropbox_permalink: string | null;
  slack_queue_message_ts: string | null;
  slack_queue_channel_id: string | null;
  reviewed_by_slack_user_id: string | null;
  reviewed_at: string | null;
  /** When the email arrived in Gmail (inbound payload), if provided */
  email_received_at: string | null;
  created_at: string;
  updated_at: string;
}

export interface AuditEvent {
  id: string;
  file_sorter_item_id: string;
  event_type: string;
  payload: Record<string, unknown>;
  created_by: string | null;
  created_at: string;
}

export interface MatchContext {
  fromEmail: string;
  toEmails: string[];
  ccEmails: string[];
  subject: string;
  bodyExcerpt: string;
  attachmentFilename: string;
  /** Populated on second-pass classification after document extraction */
  documentExcerpt?: string;
  /** Cases this sender previously filed to (helps AI disambiguate) */
  senderPriorCaseNumbers?: string[];
  /** Parsed from email body (e.g. "Attached are Lourdes Galeas Montoya records") */
  emailPatientNames?: string[];
  /** Other attachments in the same inbound email */
  siblingAttachmentFilenames?: string[];
  /** Prior attachment in this email already matched this case */
  batchSharedCaseNumber?: string;
  /** OpenAI-extracted client/case identity from all text sources */
  aiClientIdentity?: ClientIdentity;
}

/** From OpenAI reading subject + body + filename + attachment text */
export interface ClientIdentity {
  clientFullName: string | null;
  nameTokens: string[];
  caseNumberHint: string | null;
  slackChannelHint: string | null;
  /** e.g. client_contract, medical_records, court_filing */
  documentKind: string | null;
  /** Signed engagement/retainer — client may not have a case folder yet */
  isNewClientIntake: boolean;
  confidence: number;
  reason: string;
}

export interface InboundEmailPayload {
  gmailMessageId: string;
  fromEmail: string;
  toEmails: string[];
  ccEmails: string[];
  subject: string;
  bodyExcerpt: string;
  receivedAt: string;
  attachments: InboundAttachment[];
}

export interface InboundAttachment {
  filename: string;
  mimeType: string;
  size: number;
  contentBase64?: string;
  downloadUrl?: string;
}

export interface CaseCandidate {
  case: Case;
  folders: CaseFolder[];
  matchScore: number;
  matchReasons: string[];
}

export type DocumentType =
  | 'Medical Records'
  | 'Bills'
  | 'Pleadings'
  | 'Discovery'
  | 'Court Notices'
  | 'Correspondence'
  | 'Photos'
  | 'Settlement'
  | 'Insurance'
  | 'Intake'
  | 'Misc';

export interface ClassificationResult {
  suggestedCaseNumber: string | null;
  suggestedFolderPath: string | null;
  documentType: DocumentType | 'needs_attention';
  confidence: number;
  reason: string;
  needsAttention: boolean;
}

export const DOCUMENT_TYPES: DocumentType[] = [
  'Medical Records',
  'Bills',
  'Pleadings',
  'Discovery',
  'Court Notices',
  'Correspondence',
  'Photos',
  'Settlement',
  'Insurance',
  'Intake',
  'Misc',
];

export { CONFIDENCE_THRESHOLD } from '../constants/classification.js';
