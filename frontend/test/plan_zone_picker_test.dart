import 'package:flutter_test/flutter_test.dart';
import 'package:planitvibe_frontend/utils/activity_time.dart';

void main() {
  test('plan zones are IANA names with place labels', () {
    expect(planZoneChoices, [
      'America/New_York',
      'America/Chicago',
      'America/Denver',
      'America/Los_Angeles',
      'America/Anchorage',
      'Pacific/Honolulu',
      'America/Phoenix',
      'UTC',
    ]);
    expect(planZoneChoices, isNot(contains('EST')));
    expect(planZoneChoices, isNot(contains('EDT')));
    expect(planZoneMenuLabel('America/New_York'), 'Eastern · America/New_York');
    expect(planZoneMenuLabel('America/Chicago'), 'Central · America/Chicago');
    expect(planZoneMenuLabel('America/Denver'), 'Mountain · America/Denver');
    expect(planZoneMenuLabel('America/Los_Angeles'), 'Pacific · America/Los_Angeles');
    expect(planZoneMenuLabel('America/Anchorage'), 'Alaska · America/Anchorage');
    expect(planZoneMenuLabel('Pacific/Honolulu'), 'Hawaii · Pacific/Honolulu');
    expect(planZoneMenuLabel('America/Phoenix'), 'Arizona · America/Phoenix');
    expect(planZoneMenuLabel('UTC'), 'UTC');
    expect(planZoneOptions('Europe/Paris').first, 'Europe/Paris');
  });

  test('a July Eastern date displays as Eastern DT and January as Eastern ST', () {
    final july = instantFromWall(
      year: 2026,
      month: 7,
      day: 13,
      hour: 16,
      minute: 0,
      zone: 'America/New_York',
    );
    final january = instantFromWall(
      year: 2026,
      month: 1,
      day: 13,
      hour: 16,
      minute: 0,
      zone: 'America/New_York',
    );
    expect(planClockButtonLabel(july, 'America/New_York'), '7/13 16:00 Eastern DT');
    expect(planClockButtonLabel(january, 'America/New_York'), '1/13 16:00 Eastern ST');
    expect(planClockButtonLabel(july, 'America/New_York'), isNot(contains('UTC')));
    expect(zoneDaylightLabel(july, 'America/New_York'), 'Eastern DT');
    expect(zoneDaylightLabel(january, 'America/New_York'), 'Eastern ST');
  });

  test('a selected UTC zone labels the clock UTC', () {
    final july = instantFromWall(
      year: 2026,
      month: 7,
      day: 13,
      hour: 16,
      minute: 0,
      zone: 'America/New_York',
    );
    expect(planClockButtonLabel(july, 'UTC'), '7/13 20:00 UTC');
  });
}
