/**
 * Represents the decoded JWT payload
 */
export interface Decoded {
  sessionHandle?: string;
  [key: string]: any;
}