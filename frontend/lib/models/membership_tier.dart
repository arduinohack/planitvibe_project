const String tierTrial = 'trial';
const String tierPlanItVibe = 'planitvibe';
const String tierPlus = 'plus';
const String tierPro = 'pro';

const String tierTrialName = 'PlanItVibe (Trial)';
const String tierPlanItVibeName = 'PlanItVibe';
const String tierPlusName = 'PlanItVibe Plus';
const String tierProName = 'PlanItVibe Pro';

const String planItVibeGuestLabel = 'PlanItVibe Guest';

const List<String> membershipTierOrder = <String>[
  tierTrial,
  tierPlanItVibe,
  tierPlus,
  tierPro,
];

String tierDisplayName(String? tier) {
  switch ((tier ?? '').trim()) {
    case tierPlanItVibe:
      return tierPlanItVibeName;
    case tierPlus:
      return tierPlusName;
    case tierPro:
      return tierProName;
    default:
      return tierTrialName;
  }
}

int planCapForTier(String? tier) {
  switch ((tier ?? '').trim()) {
    case tierPlanItVibe:
      return 4;
    case tierPlus:
      return 10;
    case tierPro:
      return 30;
    default:
      return 2;
  }
}

/// Checkout pack for a tier the person can buy. Trial has no pack.
String? checkoutPackForTier(String? tier) {
  switch ((tier ?? '').trim()) {
    case tierPlanItVibe:
      return 'planitvibe';
    case tierPlus:
      return 'plus_monthly';
    case tierPro:
      return 'pro';
    default:
      return null;
  }
}

/// Paid tiers above [tier], lowest first.
List<String> upgradeTiersAbove(String? tier) {
  final current = (tier ?? '').trim();
  final index = membershipTierOrder.indexOf(current);
  final start = index < 0 ? 1 : index + 1;
  if (start >= membershipTierOrder.length) return const <String>[];
  return membershipTierOrder.sublist(start);
}

/// Paid tiers below [tier], lowest first. Trial is not a checkout pack.
List<String> downgradeTiersBelow(String? tier) {
  final index = membershipTierOrder.indexOf((tier ?? '').trim());
  if (index <= 1) return const <String>[];
  return membershipTierOrder.sublist(1, index);
}
