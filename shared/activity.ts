/**
 * The site activity log, shown on the admin page: who did what, when, to which database. It records
 * actions and sizes only, never what's in anyone's tables.
 */

export const ACTIVITY_ACTIONS = {
  register: "Created an account",
  login: "Signed in",
  login_failed: "Sign-in failed",
  logout: "Signed out",
  create_db: "Created a database",
  import_access: "Imported an Access file",
  import_objects: "Imported Access objects",
  open_db: "Opened a database",
  save: "Saved changes",
  rename_db: "Renamed a database",
  delete_db: "Deleted a database",
  remove_shared: "Removed a shared database from their list",
  copy_db: "Saved a copy",
  export: "Downloaded as .accdb",
  share: "Shared a database",
  unshare: "Stopped sharing with someone",
  link_access: "Changed link sharing",
  public_view: "Changed public viewing",
  publish_report: "Made a report public",
  unpublish_report: "Stopped a public report",
  public_report_view: "Public report viewed",
  public_db_view: "Public database viewed",
  record: "Recorded from a name tag",
  upload_image: "Added pictures",
  add_connection: "Added a MySQL connection",
  run_sql: "Ran SQL on MySQL",
  import_mysql: "Imported from MySQL",
  accept_policy: "Agreed to the Usage Policy",
  suspend: "Account suspended",
  unsuspend: "Account reinstated",
  plan_change: "Plan changed",
  features_change: "Features changed by admin",
  plans_settings: "Changed plan settings",
  error: "Server error",
} as const;

export type ActivityAction = keyof typeof ACTIVITY_ACTIONS;

export interface ActivityEntry {
  id: number;
  at: string;
  /** First time, when `count` > 1 (repeats within a few minutes are folded into one line). */
  firstAt: string;
  count: number;
  userId: string | null;
  email: string | null;
  name: string | null;
  action: ActivityAction;
  projectId: string | null;
  projectName: string | null;
  detail: string | null;
  ip: string | null;
}

export interface AdminOverview {
  users: number;
  newUsers7: number;
  newUsers30: number;
  active1: number;
  active7: number;
  active30: number;
  databases: number;
  storageBytes: number;
  publicReports: number;
  shares: number;
  errors24: number;
  failedLogins24: number;
  /** The last 30 days, oldest first: sign-ups and people active each day (UTC days). */
  days: { day: string; signups: number; active: number }[];
  logDays: number;
}

export interface AdminUserRow {
  id: string;
  email: string;
  name: string;
  createdAt: string;
  lastSeenAt: string | null;
  databases: number;
  sharedWithThem: number;
  storageBytes: number;
  actions30: number;
  admin: boolean;
  suspendedAt: string | null;
  suspendedReason: string | null;
  policyVersion: string | null;
  policyAcceptedAt: string | null;
}

export interface AdminUserDetail extends AdminUserRow {
  signedInDevices: number;
  dbs: {
    id: string;
    name: string;
    tables: number;
    records: number;
    sizeBytes: number;
    createdAt: string;
    updatedAt: string;
    sharedWith: number;
    linkAccess: string;
    publicView: boolean;
    publicReports: number;
  }[];
  activity: ActivityEntry[];
}
