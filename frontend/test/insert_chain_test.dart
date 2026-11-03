import 'package:flutter_test/flutter_test.dart';
import 'package:planitvibe_frontend/utils/activity_chain.dart';
import 'package:planitvibe_frontend/utils/activity_time.dart';

void main() {
  final ten = DateTime.utc(2026, 10, 5, 10);
  final eleven = DateTime.utc(2026, 10, 5, 11);
  final elevenTwenty = DateTime.utc(2026, 10, 5, 11, 20);
  final elevenThirty = DateTime.utc(2026, 10, 5, 11, 30);
  final noon = DateTime.utc(2026, 10, 5, 12);

  test('insert after keeps the 11:00 follower and leaves the noon gap', () {
    final indexes = backToBackChainIndexes(
      following: [
        const ActivityChainTime(start: null, end: null),
      ],
      anchor: eleven,
    );
    expect(indexes, isEmpty);

    final chain = backToBackChainIndexes(
      following: [
        ActivityChainTime(start: eleven, end: elevenTwenty),
        ActivityChainTime(start: noon, end: noon.add(const Duration(hours: 1))),
      ],
      anchor: eleven,
    );
    expect(chain, [0]);

    final missed = backToBackChainIndexes(
      following: [
        ActivityChainTime(start: eleven, end: elevenTwenty),
      ],
      anchor: elevenThirty,
    );
    expect(missed, isEmpty);
  });

  test('a matching start with no end is shifted and stops the chain', () {
    final indexes = backToBackChainIndexes(
      following: [
        ActivityChainTime(start: eleven, end: null),
        ActivityChainTime(start: eleven, end: elevenThirty),
      ],
      anchor: eleven,
    );
    expect(indexes, [0]);
  });

  test('insert above at the top includes the old first row and its chain', () {
    final indexes = backToBackChainIndexes(
      following: [
        ActivityChainTime(start: ten, end: eleven),
        ActivityChainTime(start: eleven, end: elevenTwenty),
        ActivityChainTime(start: noon, end: null),
      ],
      anchor: ten,
    );
    expect(indexes, [0, 1]);
  });

  test('insert above stops when the selected row does not meet the row above', () {
    final indexes = backToBackChainIndexes(
      following: [
        ActivityChainTime(start: eleven, end: elevenTwenty),
        ActivityChainTime(start: noon, end: null),
      ],
      anchor: ten,
    );
    expect(indexes, isEmpty);
  });

  test('two touching rows shift and the row after a gap stays', () {
    final indexes = backToBackChainIndexes(
      following: [
        ActivityChainTime(start: eleven, end: elevenTwenty),
        ActivityChainTime(start: elevenTwenty, end: elevenThirty),
        ActivityChainTime(start: noon, end: noon.add(const Duration(hours: 1))),
      ],
      anchor: eleven,
    );
    expect(indexes, [0, 1]);
  });

  test('an empty plan starts at 8:30 in the plan zone', () {
    final start = defaultChainStart(
      existingStarts: const [],
      planTimeZone: 'America/New_York',
      now: DateTime.utc(2026, 1, 15, 15),
    );
    final clock = clockInZone(start, 'America/New_York');
    expect(clock.year, 2026);
    expect(clock.month, 1);
    expect(clock.day, 15);
    expect(clock.hour, 8);
    expect(clock.minute, 30);
    expect(start, DateTime.utc(2026, 1, 15, 13, 30));
  });

  test('the first activity uses 8:30 on the earliest activity day', () {
    final start = defaultChainStart(
      existingStarts: [DateTime.utc(2026, 7, 4, 18)],
      planTimeZone: 'America/New_York',
      now: DateTime.utc(2026, 10, 19),
    );
    expect(start, DateTime.utc(2026, 7, 4, 12, 30));
    final clock = clockInZone(start, 'America/New_York');
    expect(clock.hour, 8);
    expect(clock.minute, 30);
    expect(clock.month, 7);
    expect(clock.day, 4);
  });

  test('a joined row keeps its duration and a gap stops the chain', () {
    final shifted = shiftJoinedChain(
      following: [
        ActivityChainTime(
          start: eleven,
          end: elevenTwenty,
          durationMinutes: 20,
        ),
        ActivityChainTime(
          start: noon,
          end: noon.add(const Duration(hours: 1)),
          durationMinutes: 60,
        ),
      ],
      anchor: eleven,
      newPriorEnd: elevenThirty,
    );
    expect(shifted, hasLength(1));
    expect(shifted.first.start, elevenThirty);
    expect(
      shifted.first.end,
      elevenThirty.add(const Duration(minutes: 20)),
    );
    expect(shifted.first.durationMinutes, 20);
  });

  test('moving an activity closes the joined chain it left', () {
    final closed = closeJoinedHole(
      following: [
        ActivityChainTime(
          start: elevenTwenty,
          end: elevenThirty,
          durationMinutes: 10,
        ),
        ActivityChainTime(
          start: noon,
          end: noon.add(const Duration(hours: 1)),
          durationMinutes: 60,
        ),
      ],
      removedEnd: elevenTwenty,
      newPriorEnd: eleven,
    );
    expect(closed, hasLength(1));
    expect(closed.first.start, eleven);
    expect(closed.first.end, eleven.add(const Duration(minutes: 10)));
    expect(closed.first.durationMinutes, 10);
  });
}
