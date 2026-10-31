import 'itinerary_cache.dart';

/// Web does not keep an itinerary snapshot.
class ItineraryCacheStore {
  Future<void> save(ItinerarySnapshot snapshot) async {}

  Future<ItinerarySnapshot?> read(String planId) async => null;

  Future<void> clear() async {}
}

ItineraryCacheStore createItineraryCacheStore() => ItineraryCacheStore();
