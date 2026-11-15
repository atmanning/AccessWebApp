/**
 * The Usage Policy everyone agrees to when they create an account. Changing the wording in a way
 * that matters: give it a new POLICY_VERSION (the date), and everyone is asked to agree again at
 * their next visit. "{site}" and "{contact}" are filled in when it's shown.
 */

export const POLICY_VERSION = "2026-11-14";
export const POLICY_TITLE = "Usage Policy";

export interface PolicySection {
  heading: string;
  paragraphs?: string[];
  bullets?: string[];
  after?: string[];
}

export const POLICY_SUMMARY = [
  "Your databases belong to you.",
  "We will never sell your data, or your personal information, to anyone.",
  "We record how the site is used (sign-ins and actions, not what's in your tables) to keep it secure and working.",
  "Use {site} lawfully and respectfully. If we find evidence of misuse, we will ban the account.",
];

export const POLICY_SECTIONS: PolicySection[] = [
  {
    heading: "1. Your data belongs to you",
    paragraphs: [
      "Everything you put into {site} (your tables, records, forms, reports and pictures) remains yours. We store it only so that the service can work for you and for the people you choose to share it with.",
      "You can download your databases at any time, and you can delete them. When you delete a database it is removed from the site; copies may remain in our backups for a limited time until those backups are replaced.",
    ],
  },
  {
    heading: "2. We will never sell your data",
    paragraphs: ["We do not sell, rent or trade your data or your personal information, and we never will. We do not use it for advertising."],
    bullets: [
      "We share it only with the companies that host and run the site for us (for example, our hosting provider), only so they can provide that service, and under their own confidentiality and security obligations.",
      "We will disclose information if the law requires it (for example, a valid court order), or when it's needed to protect someone's safety or to investigate misuse of the site.",
      "Anything you share yourself, through sharing, links, public databases or public reports, is visible to the people you shared it with.",
    ],
  },
  {
    heading: "3. What we record",
    bullets: [
      "Your account: your name, your email address and a protected (one-way scrambled) form of your password. We cannot see your password.",
      "An activity log: when you sign in, and actions such as creating, opening, saving, sharing or deleting a database, with the database's name, its size, the time and your internet (IP) address. It does not record what's in your tables. It's kept for up to 90 days.",
    ],
    after: [
      "We use this to keep the site secure, to help you when something goes wrong, to spot misuse and to understand how much the site is used.",
      "We don't look at the contents of your databases as a matter of course. We may look only when it's needed to investigate reported or suspected misuse, to fix a problem you've asked us to help with, or when the law requires it.",
    ],
  },
  {
    heading: "4. What you share is your responsibility",
    paragraphs: [
      "Anything you make public, such as a public database, a public report or a name tag's QR code, can be seen by anyone who has the link. Only publish what you have the right to share.",
      "If you store information about other people (members, students, attendees, customers), make sure you are allowed to, and follow the privacy rules that apply to you and your organisation (for example FERPA for student records, or GDPR in Europe). Ask permission before publishing anyone's personal details.",
    ],
  },
  {
    heading: "5. Acceptable use",
    paragraphs: ["When you use {site}, you agree that you will not:"],
    bullets: [
      "use it for anything illegal, or to help someone else break the law;",
      "harass, threaten, defraud or impersonate anyone, or publish hateful content;",
      "collect, store or publish other people's personal information without the right to do so;",
      "store payment card numbers, passwords for other services, or government ID numbers (the site is not designed to protect that kind of information);",
      "upload or link to malware, phishing pages or spam;",
      "share content that infringes someone else's copyright or other rights;",
      "share sexual content involving anyone under 18, or any content that exploits children;",
      "try to get into other people's accounts or databases, probe or attack the site, get around its limits, or overload it;",
      "copy, resell or automatically harvest the service or its content without our written permission.",
    ],
  },
  {
    heading: "6. Misuse means a ban",
    paragraphs: [
      "If we find evidence that an account has broken this policy, we may suspend or permanently ban it, with or without warning. A banned account can no longer sign in, and its databases are no longer available to the people it shared them with or through public links. We may also remove the content involved.",
      "Where we can, we will tell you by email why the account was suspended. If you believe we made a mistake, contact us and we will review it.",
      "We may delete the data of a banned account after 30 days. We may keep information that is needed as evidence or that the law requires us to keep, and we will report illegal content (including any content that exploits children) to the authorities.",
    ],
  },
  {
    heading: "7. Your account",
    bullets: [
      "You must be at least 13 years old to create an account.",
      "Keep your password secret. You are responsible for what happens in your account; tell us straight away if you think someone else has used it.",
      "If you create an account for an organisation, you confirm you are allowed to accept this policy on its behalf.",
    ],
  },
  {
    heading: "8. The service",
    paragraphs: [
      "We work to keep {site} running and your data safe, but we can't promise the service will always be available or free of errors. Please keep your own copies of anything important (Download as .accdb). To the extent the law allows, we are not liable for losses caused by the service being unavailable or by data being lost.",
    ],
  },
  {
    heading: "9. Changes to this policy",
    paragraphs: [
      "We may update this policy. When we make an important change, we'll show you the new version and ask you to agree to it before you continue. If you don't agree, you can download your databases and delete your account.",
    ],
  },
  {
    heading: "10. Contact",
    paragraphs: ["Questions, concerns or reports of misuse: {contact}."],
  },
];

/** Fills in the site name and contact. */
export function policyText(s: string, site: string, contact: string | null) {
  return s.replace(/\{site\}/g, site).replace(/\{contact\}/g, contact || "contact the administrator of this site");
}
