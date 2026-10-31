import 'dart:io';

import 'package:flutter_test/flutter_test.dart';
import 'package:wandervibe_frontend/models/activity.dart';
import 'package:wandervibe_frontend/models/activity_type.dart';
import 'package:wandervibe_frontend/models/plan.dart';
import 'package:wandervibe_frontend/utils/itinerary_cache.dart';
import 'package:wandervibe_frontend/utils/itinerary_cache_store.dart';

void main() {
  test('the cache is only for Android and iOS', () {
    expect(itineraryCacheEnabled(web: true, platform: 'android'), isFalse);
    expect(itineraryCacheEnabled(web: false, platform: 'windows'), isFalse);
    expect(itineraryCacheEnabled(web: false, platform: 'android'), isTrue);
    expect(itineraryCacheEnabled(web: false, platform: 'iOS'), isTrue);
  });

  test('the cache path stays inside the documents directory', () {
    expect(
      itineraryCacheFilePath(
        documentsDir: '/data/user/0/app/app_flutter',
        planId: '6a0697d7-0ef3-42ab-a3e0-e9fd3eb51b1e',
      ),
      '/data/user/0/app/app_flutter/itineraries/6a0697d7-0ef3-42ab-a3e0-e9fd3eb51b1e.json',
    );
    expect(
      itineraryCacheFilePath(
        documentsDir: '/data/user/0/app/app_flutter',
        planId: '../secret',
      ),
      '/data/user/0/app/app_flutter/itineraries/secret.json',
    );
    expect(
      itineraryCacheFilePath(
        documentsDir: r'C:\docs',
        planId: 'plan-1',
        separator: r'\',
      ),
      r'C:\docs\itineraries\plan-1.json',
    );
    expect(
      itineraryCacheFilePath(documentsDir: '   ', planId: 'plan-1'),
      isNull,
    );
    expect(
      itineraryCacheFilePath(documentsDir: '/docs', planId: '..'),
      isNull,
    );
  });

  test('a snapshot keeps the plan and activity fields', () {
    final plan = _plan();
    final snapshot = captureItinerary(
      plan: plan,
      activities: [
        Activity(
          planId: plan.id,
          name: 'Louvre',
          type: ActivityType.attraction,
          typeLabel: 'attraction',
          location: 'Rue de Rivoli, Paris',
          googlePlaceId: 'ChIJISz8NjyuEmsRFTQ9Iw7Ear8',
          startTime: DateTime.utc(2026, 10, 28, 14),
          endTime: DateTime.utc(2026, 10, 28, 17),
          details: 'Kid-friendly',
          cost: 22,
          bookingReference: 'ABC123',
        ),
      ],
    );

    final decoded = ItinerarySnapshot.decode(snapshot.encode());
    expect(decoded, isNotNull);
    expect(decoded!.planId, plan.id);
    expect(decoded.name, 'Paris trip');
    expect(decoded.timeZone, 'Europe/Paris');
    expect(decoded.activities, hasLength(1));
    final row = decoded.activities.single;
    expect(row.title, 'Louvre');
    expect(row.type, 'attraction');
    expect(row.start, '2026-10-28T14:00:00.000Z');
    expect(row.end, '2026-10-28T17:00:00.000Z');
    expect(row.location, 'Rue de Rivoli, Paris');
    expect(row.googlePlaceId, 'ChIJISz8NjyuEmsRFTQ9Iw7Ear8');
    expect(row.details, 'Kid-friendly');
    expect(row.cost, 22);
    expect(row.bookingReference, 'ABC123');

    final activity = decoded.toActivities().single;
    expect(activity.name, 'Louvre');
    expect(activity.googlePlaceId, 'ChIJISz8NjyuEmsRFTQ9Iw7Ear8');
    expect(activity.startTime, DateTime.utc(2026, 10, 28, 14));
    expect(ItinerarySnapshot.decode('not-json'), isNull);
    expect(ItinerarySnapshot.decode('{"name":"Paris"}'), isNull);
  });

  test('read and write round-trip a plan and clear removes it', () async {
    final root = await Directory.systemTemp.createTemp('wv-itinerary-');
    addTearDown(() async {
      if (await root.exists()) await root.delete(recursive: true);
    });
    final snapshot = ItinerarySnapshot(
      planId: 'plan-1',
      name: 'Paris trip',
      timeZone: 'Europe/Paris',
      activities: const [
        CachedItineraryActivity(
          title: 'Louvre',
          type: 'attraction',
          start: '2026-10-28T14:00:00.000Z',
          end: '2026-10-28T17:00:00.000Z',
          location: 'Rue de Rivoli, Paris',
          googlePlaceId: 'ChIJISz8NjyuEmsRFTQ9Iw7Ear8',
          details: 'Kid-friendly',
          cost: 22,
          bookingReference: 'ABC123',
        ),
      ],
    );
    final other = ItinerarySnapshot(
      planId: 'plan-2',
      name: 'Rome',
      timeZone: 'Europe/Rome',
      activities: const [],
    );

    await writeItineraryCacheFile(documentsDir: root.path, snapshot: snapshot);
    await writeItineraryCacheFile(documentsDir: root.path, snapshot: other);

    final readBack = await readItineraryCacheFile(
      documentsDir: root.path,
      planId: 'plan-1',
    );
    expect(readBack, isNotNull);
    expect(readBack!.name, 'Paris trip');
    expect(readBack.activities.single.googlePlaceId, 'ChIJISz8NjyuEmsRFTQ9Iw7Ear8');
    expect(
      await readItineraryCacheFile(documentsDir: root.path, planId: 'missing'),
      isNull,
    );

    await clearItineraryCacheFiles(documentsDir: root.path);
    expect(
      await readItineraryCacheFile(documentsDir: root.path, planId: 'plan-1'),
      isNull,
    );
    expect(
      await readItineraryCacheFile(documentsDir: root.path, planId: 'plan-2'),
      isNull,
    );
  });
}

Plan _plan() {
  return Plan(
    id: '6a0697d7-0ef3-42ab-a3e0-e9fd3eb51b1e',
    type: 'trip',
    name: 'Paris trip',
    destination: 'Paris',
    startDate: DateTime.utc(2026, 10, 27),
    endDate: DateTime.utc(2026, 10, 30),
    autoCalculateStartDate: false,
    autoCalculateEndDate: false,
    location: '',
    budget: null,
    planningState: 'initial',
    timeZone: 'Europe/Paris',
    ownerId: 'owner-1',
    createdAt: DateTime.utc(2026, 10, 1),
  );
}
