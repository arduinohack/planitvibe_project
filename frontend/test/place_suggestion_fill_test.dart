import 'package:flutter_test/flutter_test.dart';
import 'package:planitvibe_frontend/utils/place_suggestion_fill.dart';

void main() {
  test('a selected place fills the name, address, place id, and summary', () {
    final filled = fillActivityFromSuggestion(
      currentName: 'Dinner',
      currentLocation: 'Old street',
      currentDetails: 'Window seat',
      placeName: 'Cafe Paris',
      address: 'Paris, France',
      placeId: 'ChIJISz8NjyuEmsRFTQ9Iw7Ear8',
      summary: 'A small cafe.',
    );

    expect(filled.name, 'Cafe Paris');
    expect(filled.location, 'Paris, France');
    expect(filled.setLocation, isTrue);
    expect(filled.googlePlaceId, 'ChIJISz8NjyuEmsRFTQ9Iw7Ear8');
    expect(filled.details, 'Window seat\nA small cafe.');
  });

  test('a blank summary does not change details', () {
    final filled = fillActivityFromSuggestion(
      currentName: 'Dinner',
      currentLocation: 'Old street',
      currentDetails: 'Window seat',
      placeName: 'Cafe Paris',
      address: '',
      placeId: 'place-1',
      summary: '   ',
    );

    expect(filled.details, 'Window seat');
    expect(filled.setLocation, isFalse);
    expect(filled.location, 'Old street');
  });
}
