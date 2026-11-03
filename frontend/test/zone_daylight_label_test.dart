import 'package:flutter_test/flutter_test.dart';
import 'package:planitvibe_frontend/utils/activity_time.dart';

void main() {
  test('a zone label follows daylight time for that date', () {
    expect(
      zoneDaylightLabel(DateTime.parse('2026-01-15T17:00:00Z'), 'America/New_York'),
      'Eastern ST',
    );
    expect(
      zoneDaylightLabel(DateTime.parse('2026-07-15T16:00:00Z'), 'America/New_York'),
      'Eastern DT',
    );
    expect(
      zoneDaylightLabel(DateTime.parse('2026-07-15T19:00:00Z'), 'America/Chicago'),
      'Central DT',
    );
    expect(
      zoneDaylightLabel(DateTime.parse('2026-07-15T16:00:00Z'), 'America/Phoenix'),
      'Arizona ST',
    );
    expect(
      zoneDaylightLabel(DateTime.parse('2026-01-15T01:00:00Z'), 'Australia/Sydney'),
      'Australian Eastern DT',
    );
    expect(
      zoneDaylightLabel(DateTime.parse('2026-07-15T04:00:00Z'), 'Australia/Sydney'),
      'Australian Eastern ST',
    );
    expect(
      zoneDaylightLabel(DateTime.parse('2026-07-15T16:00:00Z'), 'UTC'),
      'UTC',
    );
  });
}
