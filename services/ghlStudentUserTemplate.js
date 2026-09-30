// services/ghlStudentUserTemplate.js
//
// The GHL user template applied to every student account created for a paid "GHL Practice
// Access" / "GHL Premium" purchase. Copied from the previous GHL workflow. Edit this file
// to change what students may see or do in the Nexistry Academy (Students) sub-account.
// `type`, `role` and the sub-account (`locationIds`) are applied in ghlStudentUsers.js.

const USER_TYPE = 'account';
const USER_ROLE = 'admin';

const PERMISSIONS = {
    campaignsEnabled: true,
    campaignsReadOnly: false,
    workflowsEnabled: true,
    workflowsReadOnly: false,
    contactsEnabled: true,
    triggersEnabled: true,
    opportunitiesEnabled: true,
    settingsEnabled: false,
    tagsEnabled: true,
    leadValueEnabled: true,
    dashboardStatsEnabled: true,
    bulkRequestsEnabled: true,
    opportunitiesBulkActionsEnabled: true,
    appointmentsEnabled: true,
    reviewsEnabled: true,
    onlineListingsEnabled: true,
    phoneCallEnabled: false,
    conversationsEnabled: true,
    assignedDataOnly: false,
    funnelsEnabled: true,
    websitesEnabled: true,
    marketingEnabled: true,
    adwordsReportingEnabled: false,
    facebookAdsReportingEnabled: false,
    attributionsReportingEnabled: false,
    membershipEnabled: true,
    botService: false,
    agentReportingEnabled: false,
    socialPlanner: true,
    bloggingEnabled: true,
    invoiceEnabled: true,
    affiliateManagerEnabled: true,
    contentAiEnabled: false,
    refundsEnabled: false,
    recordPaymentEnabled: true,
    cancelSubscriptionEnabled: true,
    paymentsEnabled: true,
    communitiesEnabled: false,
    exportPaymentsEnabled: true,
    certificatesEnabled: false,
    mediaStorageEnabled: false,
    reportingEnabled: true,
    adPublishingEnabled: false,
    adPublishingReadOnly: true,
    wordpressEnabled: false,
    customMenuLinkReadOnly: true,
    customMenuLinkWrite: false,
    gokollabEnabled: false
};

const SCOPES = [
    'audit-logs.export', 'audit-logs.readonly', 'blogs.write', 'calendars.readonly', 'calendars.write',
    'calendars/events.write', 'calendars/groups.write', 'campaigns.write', 'contacts.write',
    'contacts/bulkActions.write', 'conversations.readonly', 'conversations.write',
    'conversations/message.readonly', 'conversations/message.write', 'dashboard/stats.readonly',
    'forms.write', 'funnels.write', 'internaltools.billing-common.readonly',
    'internaltools.billing-common.write', 'invoices.readonly', 'invoices.write',
    'invoices/schedule.readonly', 'invoices/schedule.write', 'invoices/template.readonly',
    'invoices/template.write', 'locations/tags.readonly', 'locations/tags.write', 'marketing.write',
    'marketing/affiliate.write', 'membership.write', 'opportunities.write',
    'opportunities/bulkActions.write', 'opportunities/leadValue.readonly', 'payments.write',
    'payments/orders.collectPayment', 'payments/orders.export', 'payments/orders.import',
    'payments/orders.readonly', 'payments/records.write', 'payments/subscriptions.export',
    'payments/subscriptions.pauseResumeCancel', 'payments/subscriptions.readonly',
    'payments/subscriptions.sharePaymentMethod', 'payments/subscriptions.update',
    'payments/subscriptions.write', 'products.bulkActions', 'products.delete', 'products.duplicate',
    'products.readonly', 'products.write', 'qrcodes.write', 'quizzes.write',
    'reporting/facebookAds.readonly', 'reporting/reports.readonly', 'reporting/reports.write',
    'reputation/listing.write', 'reputation/review.write', 'socialplanner/account.readonly',
    'socialplanner/account.write', 'socialplanner/category.readonly', 'socialplanner/category.write',
    'socialplanner/csv.readonly', 'socialplanner/csv.write', 'socialplanner/facebook.readonly',
    'socialplanner/filters.readonly', 'socialplanner/group.write', 'socialplanner/hashtag.readonly',
    'socialplanner/hashtag.write', 'socialplanner/linkedin.readonly', 'socialplanner/medias.readonly',
    'socialplanner/medias.write', 'socialplanner/metatag.readonly',
    'socialplanner/notification.readonly', 'socialplanner/notification.write',
    'socialplanner/oauth.readonly', 'socialplanner/oauth.write', 'socialplanner/post.readonly',
    'socialplanner/post.write', 'socialplanner/recurring.readonly', 'socialplanner/recurring.write',
    'socialplanner/review.readonly', 'socialplanner/review.write', 'socialplanner/rss.readonly',
    'socialplanner/rss.write', 'socialplanner/search.readonly', 'socialplanner/setting.readonly',
    'socialplanner/setting.write', 'socialplanner/snapshot.readonly', 'socialplanner/snapshot.write',
    'socialplanner/stat.readonly', 'socialplanner/tag.readonly', 'socialplanner/tag.write',
    'socialplanner/twitter.readonly', 'socialplanner/watermarks.readonly',
    'socialplanner/watermarks.write', 'surveys.write', 'triggers.write', 'websites.write',
    'workflows.write'
];

const SCOPES_ASSIGNED_TO_ONLY = ['contacts.write', 'opportunities.write'];

module.exports = { USER_TYPE, USER_ROLE, PERMISSIONS, SCOPES, SCOPES_ASSIGNED_TO_ONLY };
