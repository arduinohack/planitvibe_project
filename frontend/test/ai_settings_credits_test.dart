import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:provider/provider.dart';
import 'package:planitvibe_frontend/models/membership_tier.dart';
import 'package:planitvibe_frontend/providers/user_provider.dart';
import 'package:planitvibe_frontend/screens/ai_settings_screen.dart';

void main() {
  testWidgets('a PlanItVibe subscriber sees Plus and Pro', (tester) async {
    await _pump(
      tester,
      const SubscriptionSettings(
        subscriptionTier: tierPlanItVibe,
        subscriptionStartedAt: '2026-03-01T15:00:00.000Z',
        subscriptionEndsAt: '2026-04-01T15:00:00.000Z',
        autoRenew: true,
        plansOwned: 3,
        planLimit: 4,
        monthlyCreditsRemaining: 11,
        purchasedCredits: 40,
      ),
    );

    _expectOrder(tester, const [
      'Current subscription: PlanItVibe',
      'Subscription started: ',
      'Subscription ends: ',
      autoSubscribedLine,
      'Plans owned: 3',
      'Plan limit: 4',
      'Remaining monthly credits: 11',
      'Purchased credits: 40',
      aiProviderLine,
      subscriptionsHeading,
      'PlanItVibe — \$5/month',
      'PlanItVibe Plus — \$10/month',
      'PlanItVibe Pro — \$25/month',
      'Upgrade to Plus — \$10/month',
      'Buy 100 credits (\$10)',
      'Buy 500 credits (\$32)',
    ]);
    expect(find.text('Subscription started: —'), findsNothing);
    expect(find.text('Upgrade to PlanItVibe'), findsNothing);
    expect(find.text('Upgrade to PlanItVibe Pro'), findsNothing);
    expect(find.text('Downgrade to PlanItVibe'), findsNothing);
    expect(find.text(plusActiveLine), findsNothing);
    _expectKeyControlsGone(tester);
  });

  testWidgets('a Plus subscriber sees PlanItVibe and Pro', (tester) async {
    await _pump(
      tester,
      const SubscriptionSettings(
        subscriptionTier: tierPlus,
        subscriptionStartedAt: '2026-03-01T15:00:00.000Z',
        subscriptionEndsAt: '2026-04-01T15:00:00.000Z',
        autoRenew: true,
        plansOwned: 2,
        unlimitedPlans: true,
        monthlyCreditsRemaining: 20,
        purchasedCredits: 0,
      ),
    );

    _expectOrder(tester, const [
      'Current subscription: PlanItVibe Plus',
      'Subscription started: ',
      'Subscription ends: ',
      autoSubscribedLine,
      'Plans owned: 2',
      'Plan limit: Unlimited',
      'Remaining monthly credits: 20',
      'Purchased credits: 0',
      aiProviderLine,
      subscriptionsHeading,
      'PlanItVibe — \$5/month',
      'PlanItVibe Plus — \$10/month',
      'PlanItVibe Pro — \$25/month',
      plusActiveLine,
      'Buy 100 credits (\$10)',
      'Buy 500 credits (\$32)',
    ]);
    expect(find.text('Upgrade to Plus — \$10/month'), findsNothing);
    expect(find.text('Upgrade to PlanItVibe Plus'), findsNothing);
    expect(find.text('Downgrade to PlanItVibe'), findsNothing);
    expect(find.text('Downgrade to PlanItVibe Plus'), findsNothing);
    expect(find.text('Upgrade to PlanItVibe Pro'), findsNothing);
    _expectKeyControlsGone(tester);
  });

  testWidgets('a trial with no subscription lists every paid tier', (tester) async {
    await _pump(
      tester,
      const SubscriptionSettings(
        plansOwned: 1,
        planLimit: 2,
        monthlyCreditsRemaining: 15,
        purchasedCredits: 0,
      ),
    );

    _expectOrder(tester, const [
      'Current subscription: Free trial or none',
      'Subscription started: —',
      'Subscription ends: —',
      'Plans owned: 1',
      'Plan limit: 2',
      'Remaining monthly credits: 15',
      'Purchased credits: 0',
      aiProviderLine,
      subscriptionsHeading,
      'PlanItVibe — \$5/month',
      'PlanItVibe Plus — \$10/month',
      'PlanItVibe Pro — \$25/month',
      'Upgrade to Plus — \$10/month',
      'Buy 100 credits (\$10)',
      'Buy 500 credits (\$32)',
      'Recent AI usage',
    ]);
    expect(find.text(autoSubscribedLine), findsNothing);
    expect(find.textContaining('Downgrade'), findsNothing);
    expect(find.text('Upgrade to PlanItVibe'), findsNothing);
    expect(find.text('Upgrade to PlanItVibe Pro'), findsNothing);
    expect(find.text(plusActiveLine), findsNothing);
    expect(find.text('Buy 100 credits (\$10)'), findsOneWidget);
    expect(find.text('Buy 500 credits (\$32)'), findsOneWidget);
    expect(find.text('Refresh'), findsOneWidget);
    expect(find.text('Recent AI usage'), findsOneWidget);
    expect(find.text('No recent AI usage'), findsOneWidget);
    _expectKeyControlsGone(tester);
  });

  test('paid tiers other than the current one stay in tier order', () {
    expect(otherPaidTiers(null), [tierPlanItVibe, tierPlus, tierPro]);
    expect(otherPaidTiers(tierPlanItVibe), [tierPlus, tierPro]);
    expect(otherPaidTiers(tierPlus), [tierPlanItVibe, tierPro]);
    expect(otherPaidTiers(tierPro), [tierPlanItVibe, tierPlus]);
    expect(
      tierCheckoutLabel(tierPlanItVibe, tierPlus),
      'Downgrade to PlanItVibe',
    );
    expect(
      tierCheckoutLabel(tierPro, tierPlus),
      'Upgrade to PlanItVibe Pro',
    );
    expect(
      subscriptionStartedLine('2026-03-01T15:00:00.000Z'),
      startsWith('Subscription started: '),
    );
    expect(subscriptionStartedLine(null), 'Subscription started: —');
    expect(subscriptionEndsLine(null), 'Subscription ends: —');
    expect(planLimitLine(unlimited: true), 'Plan limit: Unlimited');
    expect(planLimitLine(planLimit: 4), 'Plan limit: 4');
    expect(currentSubscriptionLine(null), 'Current subscription: Free trial or none');
    expect(subscriptionMoney(5), r'$5');
    expect(subscriptionMoney(1000), r'$1,000');
    expect(planOfferLine(tierPlanItVibeName, 5), 'PlanItVibe — \$5/month');
    expect(planOfferLine(tierPlusName, 10), 'PlanItVibe Plus — \$10/month');
    expect(planOfferLine(tierProName, 25), 'PlanItVibe Pro — \$25/month');
    expect(upgradeToPlusLabel(), 'Upgrade to Plus — \$10/month');
    expect(buyCreditsLabel(100, 10), 'Buy 100 credits (\$10)');
    expect(buyCreditsLabel(500, 32), 'Buy 500 credits (\$32)');
  });

  test('a fractional balance shows one decimal', () {
    expect(creditBalanceText(2), '2');
    expect(creditBalanceText(2.5), '2.5');
    expect(creditBalanceText(0.5), '0.5');
  });

  test('usage rows use readable labels and stay newest first', () {
    expect(aiUsageFeatureLabel('paste'), 'Paste');
    expect(aiUsageFeatureLabel('suggest'), 'Suggest');
    expect(aiUsageFeatureLabel('command'), 'AI edit');
    final rows = aiUsageFromBody([
      {
        'createdAt': '2026-01-15T17:00:00.000Z',
        'feature': 'paste',
        'creditCost': 0,
        'success': false,
      },
      {
        'createdAt': '2026-07-15T16:00:00.000Z',
        'feature': 'command',
        'creditCost': 1,
        'success': true,
      },
    ]);
    expect(rows, hasLength(2));
    expect(rows.first.feature, 'command');
    expect(rows.first.creditCost, 1);
    expect(aiUsageCostText(rows.first.creditCost), '1.0');
    expect(aiUsageCostText(0.5), '0.5');
    expect(aiUsageCostText(0), '0.0');
    expect(aiUsageFeatureLabel(rows.first.feature), 'AI edit');
    expect(rows.last.creditCost, 0);
    final places = aiUsageFromBody([
      {
        'createdAt': '2026-07-15T16:00:00.000Z',
        'feature': 'placeSearch',
        'creditCost': 0.5,
        'success': true,
      },
    ]);
    expect(places.single.creditCost, 0.5);
    expect(aiUsageFeatureLabel(places.single.feature), 'Place search');
    expect(aiUsageWhenText(rows.first.createdAt), isNot('—'));
    expect(aiUsageWhenText(''), '—');
  });
}

Future<void> _pump(WidgetTester tester, SubscriptionSettings status) async {
  tester.view.physicalSize = const Size(800, 2400);
  tester.view.devicePixelRatio = 1;
  addTearDown(tester.view.resetPhysicalSize);
  addTearDown(tester.view.resetDevicePixelRatio);
  await tester.pumpWidget(
    MaterialApp(
      home: ChangeNotifierProvider(
        create: (_) => UserProvider(),
        child: AiSettingsScreen(initialStatus: status),
      ),
    ),
  );
  await tester.pumpAndSettle();
}

void _expectOrder(WidgetTester tester, List<String> needles) {
  final texts = tester.widgetList<Text>(find.byType(Text)).map((text) {
    return text.data ?? '';
  }).toList();
  var from = 0;
  for (final needle in needles) {
    final index = texts.indexWhere((text) => _matches(text, needle), from);
    expect(index, greaterThanOrEqualTo(0), reason: '$needle in $texts');
    from = index + 1;
  }
}

bool _matches(String text, String needle) {
  if (needle.endsWith(': ')) return text.startsWith(needle);
  return text == needle;
}

void _expectKeyControlsGone(WidgetTester tester) {
  expect(find.text('No key is saved'), findsNothing);
  expect(find.text('A key is saved'), findsNothing);
  expect(find.text('Leave blank on Save to clear the saved key'), findsNothing);
  expect(
    find.textContaining('Confirmation paste and place summaries'),
    findsNothing,
  );
  expect(find.text('Save'), findsNothing);
  expect(find.text('API key'), findsNothing);
  expect(find.text('Clear'), findsNothing);
  expect(find.byType(TextField), findsNothing);
  expect(find.byType(DropdownButtonFormField<String>), findsNothing);
}
