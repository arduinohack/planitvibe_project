import 'package:flutter_test/flutter_test.dart';
import 'package:planitvibe_frontend/models/plan.dart';
import 'package:planitvibe_frontend/utils/activity_time.dart';

void main() {
  test('the first activity date is day 1 and six days later is day 7', () {
    final headers = planItineraryDayHeaders(
      [
        DateTime.utc(2026, 10, 5, 15),
        DateTime.utc(2026, 10, 11, 9),
      ],
      planTimeZone: 'UTC',
    );

    expect(headers, ['Day 1 · Mon 5-Oct', 'Day 7 · Sun 11-Oct']);
  });

  test('a gap is the calendar span, not the count of days with activities', () {
    final headers = planItineraryDayHeaders(
      [
        DateTime.utc(2026, 10, 1, 8),
        DateTime.utc(2026, 10, 3, 8),
        DateTime.utc(2026, 10, 6, 8),
      ],
      planTimeZone: 'UTC',
    );

    expect(headers, [
      'Day 1 · Thu 1-Oct',
      'Day 3 · Sat 3-Oct',
      'Day 6 · Tue 6-Oct',
    ]);
  });

  test('the same calendar day keeps the same number and one header', () {
    final headers = planItineraryDayHeaders(
      [
        DateTime.utc(2026, 10, 5, 9),
        DateTime.utc(2026, 10, 5, 18),
        DateTime.utc(2026, 10, 8, 9),
        DateTime.utc(2026, 10, 5, 12),
      ],
      planTimeZone: 'UTC',
    );

    expect(headers, [
      'Day 1 · Mon 5-Oct',
      null,
      'Day 4 · Thu 8-Oct',
      'Day 1 · Mon 5-Oct',
    ]);
  });

  test('the plan time zone chooses the calendar date', () {
    final headers = planItineraryDayHeaders(
      [
        DateTime.utc(2026, 10, 11, 2),
        DateTime.utc(2026, 10, 11, 18),
        DateTime.utc(2026, 10, 17, 2),
      ],
      planTimeZone: 'America/Los_Angeles',
    );

    expect(headers, [
      'Day 1 · Sat 10-Oct',
      'Day 2 · Sun 11-Oct',
      'Day 7 · Fri 16-Oct',
    ]);
  });

  test('an empty plan time zone uses the given device time zone', () {
    final headers = planItineraryDayHeaders(
      [
        DateTime.utc(2026, 10, 11, 2),
        DateTime.utc(2026, 10, 17, 2),
      ],
      planTimeZone: '   ',
      deviceTimeZone: 'America/Los_Angeles',
    );

    expect(headers, [
      'Day 1 · Sat 10-Oct',
      'Day 7 · Fri 16-Oct',
    ]);
  });

  test('4pm Alaska on July 13 stays day 1 when the plan zone is Eastern', () {
    final first = instantFromWall(
      year: 2026,
      month: 7,
      day: 13,
      hour: 9,
      minute: 0,
      zone: 'America/New_York',
    );
    final alaska = instantFromWall(
      year: 2026,
      month: 7,
      day: 13,
      hour: 16,
      minute: 0,
      zone: 'America/Anchorage',
    );

    expect(alaska.toUtc(), DateTime.utc(2026, 7, 14));
    expect(
      planItineraryDayHeaders(
        [first, alaska],
        planTimeZone: 'America/New_York',
      ),
      ['Day 1 · Mon 13-Jul', null],
    );
    expect(
      planItineraryDayHeaders(
        [first, alaska],
        planTimeZone: 'UTC',
      ),
      ['Day 1 · Mon 13-Jul', 'Day 2 · Tue 14-Jul'],
    );
  });

  test('a missing plan time zone uses the device zone, not the UTC date', () {
    final plan = Plan.fromJson({
      '_id': 'plan-1',
      'type': 'trip',
      'name': 'July',
    });
    expect(plan.timeZone, isEmpty);

    final alaska = instantFromWall(
      year: 2026,
      month: 7,
      day: 13,
      hour: 16,
      minute: 0,
      zone: 'America/Anchorage',
    );
    final headers = planItineraryDayHeaders(
      [alaska],
      planTimeZone: plan.timeZone,
      deviceTimeZone: 'America/New_York',
    );

    expect(headers, ['Day 1 · Mon 13-Jul']);
  });

  test('a start with no time stays day 1 until a date exists', () {
    final headers = planItineraryDayHeaders(
      [null, DateTime.utc(2026, 10, 5, 9)],
      planTimeZone: 'UTC',
    );

    expect(headers, ['Day 1', 'Day 1 · Mon 5-Oct']);
  });

  test('the span keeps every calendar day through the latest end', () {
    final days = planItinerarySpan(
      starts: [
        DateTime.utc(2026, 10, 1, 8),
        DateTime.utc(2026, 10, 4, 8),
      ],
      ends: [
        DateTime.utc(2026, 10, 1, 12),
        DateTime.utc(2026, 10, 6, 8),
      ],
      planTimeZone: 'UTC',
    );

    expect(
      days.map((day) => day.label).toList(),
      [
        'Day 1 · Thu 1-Oct',
        'Day 2 · Fri 2-Oct',
        'Day 3 · Sat 3-Oct',
        'Day 4 · Sun 4-Oct',
        'Day 5 · Mon 5-Oct',
        'Day 6 · Tue 6-Oct',
      ],
    );
    final indexes = planItineraryDayIndexes(
      starts: [
        DateTime.utc(2026, 10, 1, 8),
        DateTime.utc(2026, 10, 4, 8),
      ],
      days: days,
      planTimeZone: 'UTC',
    );
    expect(indexes[0], [0]);
    expect(indexes[1], isEmpty);
    expect(indexes[2], isEmpty);
    expect(indexes[3], [1]);
    expect(indexes[5], isEmpty);
  });

  test('the date has no leading zero and a three-letter month', () {
    final headers = planItineraryDayHeaders(
      [DateTime.utc(2026, 9, 7, 9)],
      planTimeZone: 'UTC',
    );

    expect(headers, ['Day 1 · Mon 7-Sep']);
  });
}
