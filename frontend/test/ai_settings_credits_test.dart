import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:provider/provider.dart';
import 'package:wandervibe_frontend/models/membership_tier.dart';
import 'package:wandervibe_frontend/providers/user_provider.dart';
import 'package:wandervibe_frontend/screens/ai_settings_screen.dart';

void main() {
  testWidgets('AI settings shows credit packs and refresh', (tester) async {
    await tester.pumpWidget(
      MaterialApp(
        home: ChangeNotifierProvider(
          create: (_) => UserProvider(),
          child: const AiSettingsScreen(),
        ),
      ),
    );
    await tester.pumpAndSettle();

    expect(find.text('Subscription and AI Settings'), findsOneWidget);
    expect(find.text('Buy 100 credits'), findsOneWidget);
    expect(find.text('Buy 500 credits'), findsOneWidget);
    expect(find.text('PlanItVibe (Trial)'), findsOneWidget);
    expect(find.text('Date subscribed: —'), findsOneWidget);
    expect(find.text('Trial ends: —'), findsOneWidget);
    expect(find.text('Plan cap: 2'), findsOneWidget);
    expect(find.text('Upgrade to PlanItVibe'), findsOneWidget);
    expect(find.text('Upgrade to PlanItVibe Plus'), findsOneWidget);
    expect(find.text('Upgrade to PlanItVibe Pro'), findsOneWidget);
    expect(find.text('Downgrade to PlanItVibe'), findsNothing);
    expect(find.text('Refresh'), findsOneWidget);
    expect(find.text('AI credits: —'), findsOneWidget);
  });

  test('paid tiers list upgrades above and downgrades below', () {
    expect(downgradeTiersBelow(tierTrial), isEmpty);
    expect(downgradeTiersBelow(tierPlanItVibe), isEmpty);
    expect(downgradeTiersBelow(tierPlus), [tierPlanItVibe]);
    expect(downgradeTiersBelow(tierPro), [tierPlanItVibe, tierPlus]);
    expect(
      subscribedLine(tier: tierPlus, subscribedAt: '2026-03-01T15:00:00.000Z'),
      startsWith('Date subscribed: '),
    );
    expect(subscribedLine(tier: tierTrial, subscribedAt: '2026-03-01T15:00:00.000Z'), 'Date subscribed: —');
    expect(
      subscriptionPeriodLine(
        tier: tierTrial,
        trialEndsAt: '2026-03-15T00:00:00.000Z',
      ),
      startsWith('Trial ends: '),
    );
    expect(
      subscriptionPeriodLine(
        tier: tierPlus,
        currentPeriodEnd: '2026-04-01T00:00:00.000Z',
      ),
      startsWith('Current period ends: '),
    );
    expect(
      subscriptionPeriodLine(
        tier: tierTrial,
        trialEndsAt: '2026-03-15T00:00:00.000Z',
        expiredAt: '2026-02-01T00:00:00.000Z',
      ),
      startsWith('Expired on '),
    );
  });

  test('a fractional balance shows one decimal', () {
    expect(creditBalanceText(2), '2');
    expect(creditBalanceText(2.5), '2.5');
    expect(creditBalanceText(0.5), '0.5');
  });
}
