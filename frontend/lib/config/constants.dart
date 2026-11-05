// Compile-time API origin. Override with --dart-define=API_BASE=http://host:3000.
const String backendBaseUrl = String.fromEnvironment(
  'API_BASE',
  defaultValue: 'http://localhost:3000',
);

// Cloudflare Turnstile site key for the signup screen.
// Override with --dart-define=TURNSTILE_SITE_KEY=...
const String turnstileSiteKey = String.fromEnvironment(
  'TURNSTILE_SITE_KEY',
  defaultValue: '0x4AAAAAAFqDgm_fCigmn45U',
);

// API paths (append to backendBaseUrl)
const String apiAuthLogin = '/api/auth/login';
const String apiAuthLogout = "/api/auth/logout";
const String apiAuthRefresh = '/api/auth/refresh';
const String apiAuthRegister = '/api/auth/register';
const String apiAuthVerifyToken =
    '/api/auth/verify-token'; // Added for token validation
const String apiAuthForgotPassword = '/api/auth/forgot-password';
const String apiAuthVerifyEmail = '/api/auth/verify-email';
const String apiAuthResendVerification = '/api/auth/resend-verification';
const String apiUsersUpdate = '/api/auth/users/{id}';
const String apiUserAiSettings = '/api/users/me/ai-settings';
const String apiUserAiCredits = '/api/users/me/ai-credits';
const String apiUserAiUsage = '/api/users/me/ai-usage';
const String apiUserAiCreditsCheckout = '/api/users/me/ai-credits/checkout';
const String apiPlans = '/api/plans';
const String apiTemplates = '/api/templates';
const String apiPublicTemplates = '/api/public/templates';
const String apiPublishedTemplates = '/api/published-templates';
const String apiPlanLink = '/api/plans/{planId}/link';
const String apiPlansItinerary = '/api/plans/{planId}/itinerary';
const String apiPlanWarnings = '/api/plans/{planId}/warnings';
const String apiPlanUsers = '/api/plans/{planId}/users';
const String apiPlanMembers = '/api/plans/{planId}/members';
const String apiPlanReassign = '/api/plans/{planId}/reassign-coordinator';
const String apiPlanPlaceMap = '/api/plans/{planId}/place-map';
const String apiPlanSuggest = '/api/plans/{planId}/suggest';
const String apiPlanAiCommand = '/api/plans/{planId}/ai-command';
const String apiPlanAiCommandApply = '/api/plans/{planId}/ai-command/apply';
const String apiPlanOptimizeDay = '/api/plans/{planId}/optimize-day';
const String apiPlanOptimizeDayApply = '/api/plans/{planId}/optimize-day/apply';
const String apiPlaceAutocomplete = '/api/places/autocomplete';
const String apiPlaceSelect = '/api/places/select';
const String apiPlanInvite = '/api/plans/{planId}/invite';
const String apiPlanInviteResend = '/api/plans/{planId}/invite/resend';
const String apiActivities = '/api/activities';
const String apiAttachments = '/api/attachments';
const String apiActivitiesAlias = '/api/events';
const String apiInvites = '/api/invites';
const String apiInvitesRespond =
    '/api/invites/invitations/{invitationId}/respond';
