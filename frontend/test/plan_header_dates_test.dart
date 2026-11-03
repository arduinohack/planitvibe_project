import 'package:flutter_test/flutter_test.dart';
import 'package:planitvibe_frontend/models/activity.dart';
import 'package:planitvibe_frontend/models/plan.dart';

Activity _activity({DateTime? start, DateTime? end}) {
  return Activity(
    planId: 'plan-1',
    name: 'Stop',
    startTime: start,
    endTime: end,
  );
}

void main() {
  test('no activities hides the date line', () {
    expect(planHeaderDateLine(const [], planTimeZone: 'UTC'), isNull);
  });

  test('activities with no start hide the date line', () {
    expect(planHeaderDateLine([_activity()], planTimeZone: 'UTC'), isNull);
    expect(
      planHeaderDateLine(
        [_activity(end: DateTime.utc(2026, 10, 6))],
        planTimeZone: 'UTC',
      ),
      isNull,
    );
  });

  test('a missing end uses that activity start', () {
    expect(
      planHeaderDateLine(
        [_activity(start: DateTime.utc(2026, 10, 5, 9))],
        planTimeZone: 'UTC',
      ),
      'Dates: 2026-10-05',
    );
  });

  test('the same plan-zone day is one date', () {
    expect(
      planHeaderDateLine(
        [
          _activity(
            start: DateTime.utc(2026, 10, 5, 9),
            end: DateTime.utc(2026, 10, 5, 18),
          ),
        ],
        planTimeZone: 'UTC',
      ),
      'Dates: 2026-10-05',
    );
  });

  test('earliest start and latest end span two dates', () {
    expect(
      planHeaderDateLine(
        [
          _activity(
            start: DateTime.utc(2026, 10, 7, 10),
            end: DateTime.utc(2026, 10, 7, 12),
          ),
          _activity(start: DateTime.utc(2026, 10, 5, 8)),
          _activity(
            start: DateTime.utc(2026, 10, 6, 9),
            end: DateTime.utc(2026, 10, 9, 17),
          ),
        ],
        planTimeZone: 'UTC',
      ),
      'Dates: 2026-10-05 - 2026-10-09',
    );
  });

  test('a 9pm Eastern end on 10/27 stays 10/27', () {
    expect(
      planHeaderDateLine(
        [
          _activity(
            start: DateTime.utc(2026, 10, 27, 13),
            end: DateTime.utc(2026, 10, 28, 1),
          ),
        ],
        planTimeZone: 'America/New_York',
      ),
      'Dates: 2026-10-27',
    );
  });

  test('list dates use earliestStart and latestEnd in the plan zone', () {
    expect(
      planSpanDateLine(
        earliestStart: null,
        latestEnd: null,
        planTimeZone: 'America/New_York',
      ),
      isNull,
    );
    expect(
      planSpanDateLine(
        earliestStart: DateTime.utc(2026, 10, 27, 13),
        latestEnd: DateTime.utc(2026, 10, 28, 1),
        planTimeZone: 'America/New_York',
      ),
      'Dates: 2026-10-27',
    );
    expect(
      planSpanDateLine(
        earliestStart: DateTime.utc(2026, 10, 5, 8),
        latestEnd: DateTime.utc(2026, 10, 9, 17),
        planTimeZone: 'UTC',
      ),
      'Dates: 2026-10-05 - 2026-10-09',
    );
  });

  test('an empty plan zone uses the device zone', () {
    expect(
      planHeaderDateLine(
        [
          _activity(
            start: DateTime.utc(2026, 10, 27, 13),
            end: DateTime.utc(2026, 10, 28, 1),
          ),
        ],
        planTimeZone: '',
        deviceTimeZone: 'America/New_York',
      ),
      'Dates: 2026-10-27',
    );
  });
}
