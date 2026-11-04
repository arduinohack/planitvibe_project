import 'dart:convert';

import 'package:flutter/material.dart';
import 'package:url_launcher/url_launcher.dart';

import '../api/api_client.dart' as api;
import '../config/constants.dart';

const excessTrialPlanMessage =
    'This plan is read-only on the free trial. Upgrade to PlanItVibe to edit it.';

String _apiMessage(String body, String fallback) {
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

Future<void> showPlusUpgradeDialog(
  BuildContext context, {
  required String message,
  required String? token,
  String pack = 'plus_monthly',
  String? tierName,
  bool showUpgrade = true,
}) {
  final excess = message.trim() == excessTrialPlanMessage;
  final checkoutPack = excess ? 'planitvibe' : pack;
  final label = excess
      ? 'Upgrade to PlanItVibe'
      : (tierName == null || tierName.trim().isEmpty
          ? 'Upgrade to Plus'
          : 'Upgrade to ${tierName.trim()}');
  return showDialog<void>(
    context: context,
    builder: (dialogContext) => AlertDialog(
      content: Text(message),
      actions: [
        TextButton(
          onPressed: () => Navigator.pop(dialogContext),
          child: const Text('Close'),
        ),
        if (showUpgrade)
          ElevatedButton(
            onPressed: () async {
              Navigator.pop(dialogContext);
              await startPlusCheckout(context, token, pack: checkoutPack);
            },
            child: Text(label),
          ),
      ],
    ),
  );
}

Future<void> startPlusCheckout(
  BuildContext context,
  String? token, {
  String pack = 'plus_monthly',
}) async {
  final messenger = ScaffoldMessenger.of(context);
  if (token == null || token.isEmpty) {
    messenger.showSnackBar(
      const SnackBar(content: Text('Sign in to buy credits')),
    );
    return;
  }
  try {
    final response = await api.post(
      Uri.parse('$backendBaseUrl$apiUserAiCreditsCheckout'),
      headers: {
        'Content-Type': 'application/json',
        'Authorization': 'Bearer $token',
      },
      body: json.encode({'pack': pack}),
    );
    if (!context.mounted) return;
    if (response.statusCode != 200) {
      messenger.showSnackBar(
        SnackBar(
          content: Text(_apiMessage(response.body, 'Could not start checkout')),
        ),
      );
      return;
    }
    final data = json.decode(response.body);
    final rawUrl = data is Map ? data['url'] : null;
    final url = rawUrl is String ? Uri.tryParse(rawUrl.trim()) : null;
    if (url == null || !url.hasScheme) {
      messenger.showSnackBar(
        const SnackBar(content: Text('Could not start checkout')),
      );
      return;
    }
    final opened = await launchUrl(url, mode: LaunchMode.externalApplication);
    if (!context.mounted) return;
    if (!opened) {
      messenger.showSnackBar(
        const SnackBar(content: Text('Could not open checkout')),
      );
    }
  } catch (_) {
    if (!context.mounted) return;
    messenger.showSnackBar(
      const SnackBar(content: Text('Could not start checkout')),
    );
  }
}
