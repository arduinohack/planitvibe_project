import 'dart:convert';

import 'package:flutter/material.dart';
import 'package:intl/intl.dart';
import 'package:provider/provider.dart';
import 'package:url_launcher/url_launcher.dart';

import '../api/api_client.dart' as api;
import '../config/constants.dart';
import '../models/membership_tier.dart';
import '../providers/plan_provider.dart';
import '../providers/user_provider.dart';
import 'login_screen.dart';

/// Whole balances stay whole. Any fraction shows one decimal, such as 2.5.
String creditBalanceText(num value) {
  if (value == value.roundToDouble()) return value.toInt().toString();
  return value.toStringAsFixed(1);
}

/// Calendar date for a subscription instant. Blank or unreadable stays an em dash.
String subscriptionDateText(String? iso) {
  final text = iso?.trim() ?? '';
  if (text.isEmpty) return '—';
  final parsed = DateTime.tryParse(text);
  if (parsed == null) return '—';
  return DateFormat.yMMMd().format(parsed.toLocal());
}

const String noSubscriptionName = 'Free trial or none';
const String autoSubscribedLine = 'Auto subscribed';
const String aiProviderLine = 'AI provider: PlanItVibe (xAI)';

/// Paid plan name, or [noSubscriptionName] when there is no subscription.
String currentSubscriptionLine(String? subscriptionTier) {
  switch ((subscriptionTier ?? '').trim()) {
    case tierPlanItVibe:
      return 'Current subscription: $tierPlanItVibeName';
    case tierPlus:
      return 'Current subscription: $tierPlusName';
    case tierPro:
      return 'Current subscription: $tierProName';
    default:
      return 'Current subscription: $noSubscriptionName';
  }
}

String subscriptionStartedLine(String? iso) {
  return 'Subscription started: ${subscriptionDateText(iso)}';
}

String subscriptionEndsLine(String? iso) {
  return 'Subscription ends: ${subscriptionDateText(iso)}';
}

String plansOwnedLine(int? owned) {
  if (owned == null) return 'Plans owned: —';
  return 'Plans owned: $owned';
}

/// Null [planLimit] is unlimited. A missing count before load uses the trial cap.
String planLimitLine({int? planLimit, bool unlimited = false}) {
  if (unlimited) return 'Plan limit: Unlimited';
  return 'Plan limit: ${planLimit ?? planCapForTier(tierTrial)}';
}

String remainingMonthlyLine(num? value) {
  if (value == null) return 'Remaining monthly credits: —';
  return 'Remaining monthly credits: ${creditBalanceText(value)}';
}

String purchasedCreditsLine(num? value) {
  if (value == null) return 'Purchased credits: —';
  return 'Purchased credits: ${creditBalanceText(value)}';
}

class AiUsageEntry {
  const AiUsageEntry({
    required this.createdAt,
    required this.feature,
    required this.creditCost,
    required this.success,
  });

  final String createdAt;
  final String feature;
  final num creditCost;
  final bool success;
}

/// Usage costs print with one decimal: 0.0, 0.5, or 1.0.
String aiUsageCostText(num value) {
  return value.toDouble().toStringAsFixed(1);
}

/// Stored feature names as the settings list shows them.
String aiUsageFeatureLabel(String feature) {
  switch (feature.trim()) {
    case 'paste':
      return 'Paste';
    case 'suggest':
      return 'Suggest';
    case 'command':
      return 'AI edit';
    case 'placeSearch':
      return 'Place search';
    default:
      final text = feature.trim();
      return text.isEmpty ? 'AI' : text;
  }
}

/// Device-zone date and time. Blank or unreadable stays an em dash.
String aiUsageWhenText(String? iso) {
  final text = iso?.trim() ?? '';
  if (text.isEmpty) return '—';
  final parsed = DateTime.tryParse(text);
  if (parsed == null) return '—';
  return DateFormat.yMMMd().add_jm().format(parsed.toLocal());
}

/// Newest first. The server already sorts; this keeps that order on the device.
List<AiUsageEntry> aiUsageFromBody(Object? body) {
  if (body is! List) return const [];
  final rows = <AiUsageEntry>[];
  for (final item in body) {
    if (item is! Map) continue;
    final feature = item['feature'];
    final created = item['createdAt'];
    final cost = item['creditCost'];
    rows.add(
      AiUsageEntry(
        createdAt: created is String ? created.trim() : '',
        feature: feature is String ? feature : '',
        creditCost: cost is num ? cost : 0,
        success: item['success'] == true,
      ),
    );
  }
  rows.sort((a, b) {
    final left = DateTime.tryParse(a.createdAt)?.millisecondsSinceEpoch ?? 0;
    final right = DateTime.tryParse(b.createdAt)?.millisecondsSinceEpoch ?? 0;
    return right.compareTo(left);
  });
  return rows;
}

/// Every paid tier except the current one, lowest first.
List<String> otherPaidTiers(String? subscriptionTier) {
  final current = (subscriptionTier ?? '').trim();
  return membershipTierOrder
      .where((tier) => tier != tierTrial && tier != current)
      .toList();
}

String tierCheckoutLabel(String tierId, String? subscriptionTier) {
  final name = tierDisplayName(tierId);
  final current = (subscriptionTier ?? '').trim();
  final currentIndex = membershipTierOrder.indexOf(current);
  final tierIndex = membershipTierOrder.indexOf(tierId);
  if (currentIndex > tierIndex) return 'Downgrade to $name';
  return 'Upgrade to $name';
}

/// Whole dollars in the same currency family as activity costs: $5, $1,000.
String subscriptionMoney(num amount) {
  return NumberFormat.currency(
    locale: 'en_US',
    symbol: r'$',
    decimalDigits: 0,
  ).format(amount);
}

const int planItVibeMonthlyDollars = 5;
const int plusMonthlyDollars = 10;
const int proMonthlyDollars = 25;
const int planItVibeMonthlyCredits = 16;
const int plusMonthlyCredits = 20;
const int proMonthlyCredits = 50;
const int credits100Dollars = 10;
const int credits500Dollars = 32;

const String subscriptionsHeading = 'Subscriptions';
const String plusActiveLine = 'Plus active';
const String proActiveLine = 'Pro active';

/// Price and the AI credits renewed each month. Checkout stays on Plus and Pro.
String planOfferLine(String name, num dollarsPerMonth, int monthlyCredits) {
  return '$name — ${subscriptionMoney(dollarsPerMonth)}/month — $monthlyCredits AI Credits';
}

String upgradeToPlusLabel() {
  return 'Upgrade to Plus — ${subscriptionMoney(plusMonthlyDollars)}/month';
}

String upgradeToProLabel() {
  return 'Upgrade to Pro — ${subscriptionMoney(proMonthlyDollars)}/month';
}

String buyCreditsLabel(int credits, num dollars) {
  return 'Buy $credits credits (${subscriptionMoney(dollars)})';
}

class SubscriptionSettings {
  const SubscriptionSettings({
    this.subscriptionTier,
    this.subscriptionStartedAt,
    this.subscriptionEndsAt,
    this.autoRenew = false,
    this.plansOwned,
    this.planLimit,
    this.unlimitedPlans = false,
    this.monthlyCreditsRemaining,
    this.purchasedCredits,
  });

  final String? subscriptionTier;
  final String? subscriptionStartedAt;
  final String? subscriptionEndsAt;
  final bool autoRenew;
  final int? plansOwned;
  final int? planLimit;
  final bool unlimitedPlans;
  final num? monthlyCreditsRemaining;
  final num? purchasedCredits;

  static const empty = SubscriptionSettings(planLimit: 2);
}

String? _dateField(Map body, String key) {
  final value = body[key];
  if (value is! String || value.trim().isEmpty) return null;
  return value.trim();
}

String? _tierField(Map body) {
  if (!body.containsKey('subscriptionTier')) {
    final legacy = body['tier'];
    if (legacy is String && legacy.trim().isNotEmpty && legacy.trim() != tierTrial) {
      return legacy.trim();
    }
    return null;
  }
  final value = body['subscriptionTier'];
  if (value is! String || value.trim().isEmpty) return null;
  return value.trim();
}

int? _intField(Object? value) {
  if (value is num) return value.round();
  return null;
}

SubscriptionSettings subscriptionSettingsFromBody(Map body) {
  final tier = _tierField(body);
  final unlimited = body.containsKey('planLimit')
      ? body['planLimit'] == null
      : tier == tierPlus || tier == tierPro;
  final planLimit = unlimited ? null : _intField(body['planLimit']) ?? planCapForTier(tier);
  final monthly = body['monthlyCreditsRemaining'] ?? body['monthlyCredits'];
  final purchased = body['purchasedCredits'];
  return SubscriptionSettings(
    subscriptionTier: tier,
    subscriptionStartedAt: _dateField(body, 'subscriptionStartedAt') ??
        (tier == null ? null : _dateField(body, 'subscribedAt')),
    subscriptionEndsAt: _dateField(body, 'subscriptionEndsAt') ??
        (tier == null ? null : _dateField(body, 'currentPeriodEnd')),
    autoRenew: body['autoRenew'] == true,
    plansOwned: _intField(body['plansOwned']),
    planLimit: planLimit,
    unlimitedPlans: unlimited,
    monthlyCreditsRemaining: monthly is num ? monthly : null,
    purchasedCredits: purchased is num ? purchased : null,
  );
}

String? _apiMessage(String body, String fallback) {
  try {
    final data = json.decode(body);
    if (data is Map) {
      final message = data['message'] ?? data['msg'];
      if (message is String && message.trim().isNotEmpty) {
        return message.trim();
      }
    }
  } catch (_) {}
  return fallback;
}

class AiSettingsScreen extends StatefulWidget {
  const AiSettingsScreen({super.key, this.initialStatus});

  /// Loaded snapshot. The screen fetches the status when this is omitted.
  final SubscriptionSettings? initialStatus;

  @override
  State<AiSettingsScreen> createState() => _AiSettingsScreenState();
}

class _AiSettingsScreenState extends State<AiSettingsScreen> {
  SubscriptionSettings _status = SubscriptionSettings.empty;
  List<AiUsageEntry> _usage = const [];
  bool _loading = true;
  bool _busy = false;
  String? _error;
  String? _usageError;

  @override
  void initState() {
    super.initState();
    final initial = widget.initialStatus;
    if (initial != null) {
      _status = initial;
      _loading = false;
      return;
    }
    WidgetsBinding.instance.addPostFrameCallback((_) {
      if (mounted) _load();
    });
  }

  String? get _token {
    return Provider.of<UserProvider>(context, listen: false).token;
  }

  Future<void> _endSession() async {
    final userProvider = Provider.of<UserProvider>(context, listen: false);
    final planProvider = Provider.of<PlanProvider>(context, listen: false);
    final navigator = Navigator.of(context);
    planProvider.clearPlans();
    await userProvider.logout();
    if (!mounted) return;
    navigator.pushAndRemoveUntil(
      MaterialPageRoute(builder: (context) => const LoginScreen()),
      (route) => false,
    );
  }

  Future<void> _load() async {
    final token = _token;
    if (token == null || token.isEmpty) {
      if (!mounted) return;
      setState(() {
        _loading = false;
        _busy = false;
        _error = 'Sign in to view AI settings';
      });
      return;
    }
    try {
      final headers = {'Authorization': 'Bearer $token'};
      final creditResponse = await api.get(
        Uri.parse('$backendBaseUrl$apiUserAiCredits'),
        headers: headers,
      );
      if (!mounted) return;
      if (creditResponse.statusCode == 401) {
        await _endSession();
        return;
      }
      SubscriptionSettings? nextStatus;
      String? nextError;
      if (creditResponse.statusCode != 200) {
        nextError = _apiMessage(creditResponse.body, 'Could not load AI settings');
      } else {
        final creditBody = json.decode(creditResponse.body);
        if (creditBody is! Map) {
          nextError = 'Could not load AI settings';
        } else {
          final status = subscriptionSettingsFromBody(creditBody);
          if (status.monthlyCreditsRemaining == null ||
              status.purchasedCredits == null) {
            nextError = 'Could not load AI settings';
          } else {
            nextStatus = status;
          }
        }
      }

      final usageResponse = await api.get(
        Uri.parse('$backendBaseUrl$apiUserAiUsage'),
        headers: headers,
      );
      if (!mounted) return;
      if (usageResponse.statusCode == 401) {
        await _endSession();
        return;
      }
      List<AiUsageEntry> nextUsage = const [];
      String? usageError;
      if (usageResponse.statusCode != 200) {
        usageError = _apiMessage(
          usageResponse.body,
          'Could not load recent AI usage',
        );
      } else {
        final usageBody = json.decode(usageResponse.body);
        if (usageBody is! List) {
          usageError = 'Could not load recent AI usage';
        } else {
          nextUsage = aiUsageFromBody(usageBody);
        }
      }
      setState(() {
        if (nextStatus != null) _status = nextStatus;
        _usage = nextUsage;
        _usageError = usageError;
        _error = nextError;
        _loading = false;
        _busy = false;
      });
    } catch (_) {
      if (!mounted) return;
      setState(() {
        _loading = false;
        _busy = false;
        _error = 'Could not load AI settings';
      });
    }
  }

  String _packForTier(String tierId) {
    if (tierId == tierPlus) return 'plus';
    return checkoutPackForTier(tierId)!;
  }

  Future<void> _buy(String pack) async {
    if (_busy) return;
    final messenger = ScaffoldMessenger.of(context);
    final token = _token;
    if (token == null || token.isEmpty) {
      messenger.showSnackBar(
        const SnackBar(content: Text('Sign in to buy credits')),
      );
      return;
    }
    setState(() {
      _busy = true;
      _error = null;
    });
    try {
      final response = await api.post(
        Uri.parse('$backendBaseUrl$apiUserAiCreditsCheckout'),
        headers: {
          'Content-Type': 'application/json',
          'Authorization': 'Bearer $token',
        },
        body: json.encode({'pack': pack}),
      );
      if (!mounted) return;
      if (response.statusCode != 200) {
        setState(() => _busy = false);
        messenger.showSnackBar(
          SnackBar(
            content: Text(
              _apiMessage(response.body, 'Could not start checkout') ??
                  'Could not start checkout',
            ),
          ),
        );
        return;
      }
      final data = json.decode(response.body);
      final rawUrl = data is Map ? data['url'] : null;
      final url = rawUrl is String ? Uri.tryParse(rawUrl.trim()) : null;
      if (url == null || !url.hasScheme) {
        setState(() => _busy = false);
        messenger.showSnackBar(
          const SnackBar(content: Text('Could not start checkout')),
        );
        return;
      }
      final opened = await launchUrl(url, mode: LaunchMode.externalApplication);
      if (!mounted) return;
      setState(() => _busy = false);
      if (!opened) {
        messenger.showSnackBar(
          const SnackBar(content: Text('Could not open checkout')),
        );
      }
    } catch (_) {
      if (!mounted) return;
      setState(() => _busy = false);
      messenger.showSnackBar(
        const SnackBar(content: Text('Could not start checkout')),
      );
    }
  }

  @override
  Widget build(BuildContext context) {
    final status = _status;
    final tier = status.subscriptionTier;
    return Scaffold(
      appBar: AppBar(title: const Text('Subscription and AI Settings')),
      body: _loading
          ? const Center(child: CircularProgressIndicator())
          : RefreshIndicator(
              onRefresh: _load,
              child: ListView(
                physics: const AlwaysScrollableScrollPhysics(),
                padding: const EdgeInsets.all(16),
                children: [
                  Text(currentSubscriptionLine(tier)),
                  const SizedBox(height: 8),
                  Text(subscriptionStartedLine(status.subscriptionStartedAt)),
                  const SizedBox(height: 8),
                  Text(subscriptionEndsLine(status.subscriptionEndsAt)),
                  if (status.autoRenew) ...[
                    const SizedBox(height: 8),
                    const Text(autoSubscribedLine),
                  ],
                  const SizedBox(height: 8),
                  Text(plansOwnedLine(status.plansOwned)),
                  const SizedBox(height: 8),
                  Text(
                    planLimitLine(
                      planLimit: status.planLimit,
                      unlimited: status.unlimitedPlans,
                    ),
                  ),
                  const SizedBox(height: 8),
                  Text(remainingMonthlyLine(status.monthlyCreditsRemaining)),
                  const SizedBox(height: 8),
                  Text(purchasedCreditsLine(status.purchasedCredits)),
                  const SizedBox(height: 8),
                  const Text(aiProviderLine),
                  const SizedBox(height: 16),
                  const Text(
                    subscriptionsHeading,
                    style: TextStyle(fontWeight: FontWeight.w600),
                  ),
                  const SizedBox(height: 8),
                  Text(
                    planOfferLine(
                      tierPlanItVibeName,
                      planItVibeMonthlyDollars,
                      planItVibeMonthlyCredits,
                    ),
                  ),
                  const SizedBox(height: 8),
                  Text(
                    planOfferLine(
                      tierPlusName,
                      plusMonthlyDollars,
                      plusMonthlyCredits,
                    ),
                  ),
                  const SizedBox(height: 8),
                  Text(
                    planOfferLine(
                      tierProName,
                      proMonthlyDollars,
                      proMonthlyCredits,
                    ),
                  ),
                  const SizedBox(height: 12),
                  Wrap(
                    spacing: 12,
                    runSpacing: 8,
                    children: [
                      if (tier == tierPlus)
                        const Text(plusActiveLine)
                      else if (tier != tierPro)
                        OutlinedButton(
                          onPressed: _busy
                              ? null
                              : () => _buy(_packForTier(tierPlus)),
                          child: Text(upgradeToPlusLabel()),
                        ),
                      if (tier == tierPro)
                        const Text(proActiveLine)
                      else
                        OutlinedButton(
                          onPressed: _busy
                              ? null
                              : () => _buy(_packForTier(tierPro)),
                          child: Text(upgradeToProLabel()),
                        ),
                      OutlinedButton(
                        onPressed: _busy ? null : () => _buy('100'),
                        child: Text(buyCreditsLabel(100, credits100Dollars)),
                      ),
                      OutlinedButton(
                        onPressed: _busy ? null : () => _buy('500'),
                        child: Text(buyCreditsLabel(500, credits500Dollars)),
                      ),
                      TextButton(
                        onPressed: _busy ? null : _load,
                        child: const Text('Refresh'),
                      ),
                    ],
                  ),
                  const SizedBox(height: 24),
                  const Text(
                    'Recent AI usage',
                    style: TextStyle(fontWeight: FontWeight.w600),
                  ),
                  const SizedBox(height: 8),
                  if (_usageError != null)
                    Text(
                      _usageError!,
                      style: TextStyle(
                        color: Theme.of(context).colorScheme.error,
                      ),
                    )
                  else if (_usage.isEmpty)
                    const Text('No recent AI usage')
                  else
                    for (final row in _usage)
                      Padding(
                        padding: const EdgeInsets.only(bottom: 8),
                        child: Row(
                          crossAxisAlignment: CrossAxisAlignment.start,
                          children: [
                            Expanded(
                              child: Text(aiUsageWhenText(row.createdAt)),
                            ),
                            const SizedBox(width: 12),
                            Expanded(
                              child: Text(aiUsageFeatureLabel(row.feature)),
                            ),
                            Text(aiUsageCostText(row.creditCost)),
                          ],
                        ),
                      ),
                  if (_error != null) ...[
                    const SizedBox(height: 16),
                    Text(
                      _error!,
                      style: TextStyle(
                        color: Theme.of(context).colorScheme.error,
                      ),
                    ),
                  ],
                ],
              ),
            ),
    );
  }
}
