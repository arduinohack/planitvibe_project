import 'dart:convert';

import 'package:flutter/material.dart';
import 'package:intl/intl.dart';
import 'package:provider/provider.dart';
import 'package:url_launcher/url_launcher.dart';

import '../api/api_client.dart' as api;
import '../config/constants.dart';
import '../models/membership_tier.dart';
import '../providers/user_provider.dart';

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

String subscribedLine({required String tier, String? subscribedAt}) {
  if (tier == tierTrial) return 'Date subscribed: —';
  return 'Date subscribed: ${subscriptionDateText(subscribedAt)}';
}

String subscriptionPeriodLine({
  required String tier,
  String? trialEndsAt,
  String? currentPeriodEnd,
  String? expiredAt,
}) {
  if ((expiredAt ?? '').trim().isNotEmpty) {
    return 'Expired on ${subscriptionDateText(expiredAt)}';
  }
  if (tier == tierTrial) {
    return 'Trial ends: ${subscriptionDateText(trialEndsAt)}';
  }
  return 'Current period ends: ${subscriptionDateText(currentPeriodEnd)}';
}

String? _dateField(Map body, String key) {
  final value = body[key];
  if (value is! String || value.trim().isEmpty) return null;
  return value.trim();
}

const _providerValues = <String>[
  'xai',
  'openai',
  'anthropic',
  'gemini',
  'none',
];

String _providerLabel(String provider) {
  switch (provider) {
    case 'xai':
      return 'xAI';
    case 'openai':
      return 'OpenAI';
    case 'anthropic':
      return 'Anthropic';
    case 'gemini':
      return 'Gemini';
    default:
      return 'None';
  }
}

String _knownProvider(Object? value) {
  if (value is String && _providerValues.contains(value)) return value;
  return 'none';
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
  const AiSettingsScreen({super.key});

  @override
  State<AiSettingsScreen> createState() => _AiSettingsScreenState();
}

class _AiSettingsScreenState extends State<AiSettingsScreen> {
  final _keyController = TextEditingController();
  String _provider = 'none';
  String _savedProvider = 'none';
  bool _hasKey = false;
  num? _monthlyCredits;
  num? _purchasedCredits;
  String _tier = tierTrial;
  String _tierName = tierTrialName;
  int _planCap = 2;
  int? _plansOwned;
  String? _subscribedAt;
  String? _currentPeriodEnd;
  String? _expiredAt;
  String? _trialEndsAt;
  bool _loading = true;
  bool _busy = false;
  String? _error;
  int _formGeneration = 0;

  @override
  void initState() {
    super.initState();
    WidgetsBinding.instance.addPostFrameCallback((_) {
      if (mounted) _load();
    });
  }

  @override
  void dispose() {
    _keyController.dispose();
    super.dispose();
  }

  String? get _token {
    return Provider.of<UserProvider>(context, listen: false).token;
  }

  void _applyStatus(
    String provider,
    bool hasKey,
    num monthlyCredits,
    num purchasedCredits, {
    String tier = tierTrial,
    String? tierName,
    int? planCap,
    int? plansOwned,
    String? subscribedAt,
    String? currentPeriodEnd,
    String? expiredAt,
    String? trialEndsAt,
  }) {
    _keyController.clear();
    setState(() {
      _savedProvider = provider;
      _hasKey = hasKey;
      _monthlyCredits = monthlyCredits;
      _purchasedCredits = purchasedCredits;
      _tier = tier;
      _tierName = tierName == null || tierName.trim().isEmpty
          ? tierDisplayName(tier)
          : tierName.trim();
      _planCap = planCap ?? planCapForTier(tier);
      _plansOwned = plansOwned;
      _subscribedAt = subscribedAt;
      _currentPeriodEnd = currentPeriodEnd;
      _expiredAt = expiredAt;
      _trialEndsAt = trialEndsAt;
      _provider = provider;
      _formGeneration += 1;
      _error = null;
      _loading = false;
      _busy = false;
    });
  }

  String _creditText(num value) {
    return creditBalanceText(value);
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
      final responses = await Future.wait([
        api.get(
          Uri.parse('$backendBaseUrl$apiUserAiSettings'),
          headers: headers,
        ),
        api.get(
          Uri.parse('$backendBaseUrl$apiUserAiCredits'),
          headers: headers,
        ),
      ]);
      if (!mounted) return;
      final settings = responses[0];
      final credits = responses[1];
      if (settings.statusCode != 200 || credits.statusCode != 200) {
        final failed = settings.statusCode != 200 ? settings : credits;
        setState(() {
          _loading = false;
          _busy = false;
          _error = _apiMessage(failed.body, 'Could not load AI settings');
        });
        return;
      }
      final data = json.decode(settings.body);
      final creditBody = json.decode(credits.body);
      final monthly = creditBody is Map ? creditBody['monthlyCredits'] : null;
      final purchased = creditBody is Map ? creditBody['purchasedCredits'] : null;
      if (data is! Map || data['hasKey'] is! bool || monthly is! num || purchased is! num) {
        setState(() {
          _loading = false;
          _busy = false;
          _error = 'Could not load AI settings';
        });
        return;
      }
      final rawTier = creditBody is Map ? creditBody['tier'] : null;
      final paid = creditBody is Map && creditBody['plusActive'] == true;
      final tier = rawTier is String && rawTier.trim().isNotEmpty
          ? rawTier.trim()
          : (paid ? tierPlus : tierTrial);
      final rawName = creditBody is Map ? creditBody['tierName'] : null;
      final rawCap = creditBody is Map ? creditBody['planCap'] : null;
      final rawOwned = creditBody is Map ? creditBody['plansOwned'] : null;
      final creditsMap = creditBody is Map ? creditBody : const <String, dynamic>{};
      _applyStatus(
        _knownProvider(data['aiProvider']),
        data['hasKey'] as bool,
        monthly,
        purchased,
        tier: tier,
        tierName: rawName is String ? rawName : null,
        planCap: rawCap is num ? rawCap.round() : null,
        plansOwned: rawOwned is num ? rawOwned.round() : null,
        subscribedAt: _dateField(creditsMap, 'subscribedAt'),
        currentPeriodEnd: _dateField(creditsMap, 'currentPeriodEnd'),
        expiredAt: _dateField(creditsMap, 'expiredAt'),
        trialEndsAt: _dateField(creditsMap, 'trialEndsAt'),
      );
    } catch (_) {
      if (!mounted) return;
      setState(() {
        _loading = false;
        _busy = false;
        _error = 'Could not load AI settings';
      });
    }
  }

  Future<void> _save({required bool clear}) async {
    if (_busy) return;
    final messenger = ScaffoldMessenger.of(context);
    final token = _token;
    if (token == null || token.isEmpty) {
      setState(() => _error = 'Sign in to save AI settings');
      return;
    }
    final provider = clear ? 'none' : _provider;
    final apiKey = clear || provider == 'none'
        ? ''
        : _keyController.text.trim();
    setState(() {
      _busy = true;
      _error = null;
    });
    try {
      final response = await api.put(
        Uri.parse('$backendBaseUrl$apiUserAiSettings'),
        headers: {
          'Content-Type': 'application/json',
          'Authorization': 'Bearer $token',
        },
        body: json.encode({'aiProvider': provider, 'apiKey': apiKey}),
      );
      if (!mounted) return;
      if (response.statusCode != 200) {
        setState(() {
          _busy = false;
          _error = _apiMessage(response.body, 'Could not save AI settings');
        });
        return;
      }
      await _load();
      if (!mounted) return;
      messenger.showSnackBar(
        SnackBar(content: Text(clear ? 'AI key cleared' : 'AI settings saved')),
      );
    } catch (_) {
      if (!mounted) return;
      setState(() {
        _busy = false;
        _error = 'Could not save AI settings';
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
                  Text('Provider: ${_providerLabel(_savedProvider)}'),
                  const SizedBox(height: 8),
                  Text(_hasKey ? 'A key is saved' : 'No key is saved'),
                  const SizedBox(height: 8),
                  Text(_tierName),
                  const SizedBox(height: 8),
                  Text(subscribedLine(tier: _tier, subscribedAt: _subscribedAt)),
                  const SizedBox(height: 8),
                  Text(
                    subscriptionPeriodLine(
                      tier: _tier,
                      trialEndsAt: _trialEndsAt,
                      currentPeriodEnd: _currentPeriodEnd,
                      expiredAt: _expiredAt,
                    ),
                  ),
                  const SizedBox(height: 8),
                  Text('Plan cap: $_planCap'),
                  if (_plansOwned != null) ...[
                    const SizedBox(height: 8),
                    Text('Plans owned: $_plansOwned'),
                  ],
                  const SizedBox(height: 8),
                  Text(
                    _monthlyCredits == null
                        ? 'Monthly credits: —'
                        : 'Monthly credits: ${_creditText(_monthlyCredits!)}',
                  ),
                  const SizedBox(height: 8),
                  Text(
                    _purchasedCredits == null
                        ? 'Purchased credits: —'
                        : 'Purchased credits: ${_creditText(_purchasedCredits!)}',
                  ),
                  const SizedBox(height: 8),
                  Wrap(
                    spacing: 12,
                    runSpacing: 8,
                    children: [
                      for (final tierId in upgradeTiersAbove(_tier))
                        OutlinedButton(
                          onPressed: _busy
                              ? null
                              : () => _buy(_packForTier(tierId)),
                          child: Text(
                            'Upgrade to ${tierDisplayName(tierId)}',
                          ),
                        ),
                      for (final tierId in downgradeTiersBelow(_tier))
                        TextButton(
                          onPressed: _busy
                              ? null
                              : () => _buy(_packForTier(tierId)),
                          child: Text(
                            'Downgrade to ${tierDisplayName(tierId)}',
                          ),
                        ),
                      OutlinedButton(
                        onPressed: _busy ? null : () => _buy('100'),
                        child: const Text('Buy 100 credits'),
                      ),
                      OutlinedButton(
                        onPressed: _busy ? null : () => _buy('500'),
                        child: const Text('Buy 500 credits'),
                      ),
                      TextButton(
                        onPressed: _busy ? null : _load,
                        child: const Text('Refresh'),
                      ),
                    ],
                  ),
                  const SizedBox(height: 8),
                  const Text(
                    'Confirmation paste and place summaries use a saved key. With no saved key, the server key is used.',
                  ),
                  const SizedBox(height: 24),
                  DropdownButtonFormField<String>(
                    key: ValueKey('ai-provider-$_formGeneration'),
                    initialValue: _provider,
                    decoration: const InputDecoration(
                      labelText: 'Provider',
                      border: OutlineInputBorder(),
                    ),
                    items: [
                      for (final value in _providerValues)
                        DropdownMenuItem<String>(
                          value: value,
                          child: Text(_providerLabel(value)),
                        ),
                    ],
                    onChanged: _busy
                        ? null
                        : (value) {
                            if (value == null) return;
                            setState(() => _provider = value);
                          },
                  ),
                  const SizedBox(height: 16),
                  TextField(
                    controller: _keyController,
                    obscureText: true,
                    enableSuggestions: false,
                    autocorrect: false,
                    enabled: !_busy,
                    decoration: const InputDecoration(
                      labelText: 'API key',
                      border: OutlineInputBorder(),
                      helperText: 'Leave blank on Save to clear the saved key',
                    ),
                  ),
                  const SizedBox(height: 16),
                  Row(
                    children: [
                      FilledButton(
                        onPressed: _busy ? null : () => _save(clear: false),
                        child: const Text('Save'),
                      ),
                      const SizedBox(width: 12),
                      OutlinedButton(
                        onPressed: _busy ? null : () => _save(clear: true),
                        child: const Text('Clear'),
                      ),
                    ],
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
