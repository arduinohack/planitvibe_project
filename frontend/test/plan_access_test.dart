import 'package:flutter_test/flutter_test.dart';
import 'package:planitvibe_frontend/models/plan_access.dart';

void main() {
  test('trial label rounds the remaining time up to a whole day', () {
    final now = DateTime.now().toUtc();
    final soon = PlanAccess(
      plusActive: false,
      trialActive: true,
      trialStartedAt: now,
      trialEndsAt: now.add(const Duration(hours: 3)),
      plansOwned: 1,
    );
    expect(soon.trialEndsLabel, 'Trial ends in 1 day');
    expect(soon.readOnly, isFalse);

    final longer = PlanAccess(
      plusActive: false,
      trialActive: true,
      trialStartedAt: now,
      trialEndsAt: now.add(const Duration(days: 13, hours: 1)),
      plansOwned: 1,
    );
    expect(longer.trialEndsLabel, 'Trial ends in 14 days');
  });

  test('past trial without Plus is read only', () {
    final access = PlanAccess(
      plusActive: false,
      trialActive: false,
      trialStartedAt: DateTime.utc(2026, 1, 1),
      trialEndsAt: DateTime.utc(2026, 1, 15),
      plansOwned: 1,
    );
    expect(access.trialEndsLabel, isNull);
    expect(access.readOnly, isTrue);
  });

  test('Plus stays editable after the trial', () {
    final access = PlanAccess(
      plusActive: true,
      trialActive: false,
      trialStartedAt: DateTime.utc(2026, 1, 1),
      trialEndsAt: DateTime.utc(2026, 1, 15),
      plansOwned: 3,
    );
    expect(access.readOnly, isFalse);
    expect(access.trialEndsLabel, isNull);
  });

  test('a user who has not started a trial is not read only', () {
    const access = PlanAccess(
      plusActive: false,
      trialActive: false,
      trialStartedAt: null,
      trialEndsAt: null,
      plansOwned: 0,
    );
    expect(access.readOnly, isFalse);
    expect(access.trialEndsLabel, isNull);
  });

  test('fromJson reads the credit summary', () {
    final access = PlanAccess.fromJson({
      'plusActive': false,
      'trialActive': true,
      'trialStartedAt': '2026-10-01T00:00:00.000Z',
      'trialEndsAt': '2026-10-15T00:00:00.000Z',
      'plansOwned': 2,
    });
    expect(access.plusActive, isFalse);
    expect(access.trialActive, isTrue);
    expect(access.plansOwned, 2);
    expect(access.trialEndsAt, DateTime.utc(2026, 10, 15));
  });
}
