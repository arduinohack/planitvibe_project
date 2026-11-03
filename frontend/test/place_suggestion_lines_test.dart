import 'package:flutter_test/flutter_test.dart';
import 'package:planitvibe_frontend/utils/place_suggestion_lines.dart';

void main() {
  test('a result shows the address and summary', () {
    expect(
      suggestionListSubtitle(
        address: 'Paris, France',
        summary: 'A small cafe.',
      ),
      'Paris, France\nA small cafe.',
    );
  });

  test('a blank summary leaves the address', () {
    expect(
      suggestionListSubtitle(address: 'Rome, Italy'),
      'Rome, Italy',
    );
  });

  test('an empty dining search uses restaurant and the form location', () {
    expect(
      suggestSearchQuery(
        typed: '  ',
        activityType: 'dining',
        location: 'Rome',
        destination: 'Paris',
      ),
      'restaurant in Rome',
    );
  });

  test('an empty hotel search uses the plan destination', () {
    expect(
      suggestSearchQuery(
        typed: '',
        activityType: 'hotel',
        destination: 'Paris',
      ),
      'hotel in Paris',
    );
  });

  test('an empty attraction or tour search uses that word', () {
    expect(
      suggestSearchQuery(typed: '', activityType: 'attraction'),
      'attraction',
    );
    expect(
      suggestSearchQuery(
        typed: '',
        activityType: 'tour',
        location: 'Lisbon',
      ),
      'tour in Lisbon',
    );
  });

  test('typed text is sent as written', () {
    expect(
      suggestSearchQuery(
        typed: 'quiet cafe',
        activityType: 'dining',
        location: 'Rome',
      ),
      'quiet cafe',
    );
  });

  test('an empty query with no chip does not search', () {
    expect(suggestSearchQuery(typed: '', activityType: 'flight'), isNull);
    expect(suggestSearchQuery(typed: '   '), isNull);
  });

  test('a dining activity searches restaurants plus the typed text and location', () {
    expect(
      suggestLockedTypeQuery(
        typed: 'quiet cafe',
        activityType: 'dining',
        location: 'Rome',
        destination: 'Paris',
      ),
      'restaurant quiet cafe in Rome',
    );
    expect(
      suggestLockedTypeQuery(
        typed: '',
        activityType: 'dining',
        location: 'Rome',
      ),
      'restaurant in Rome',
    );
  });

  test('a locked hotel search uses typed text and the plan destination', () {
    expect(
      suggestLockedTypeQuery(
        typed: 'with a pool',
        activityType: 'hotel',
        destination: 'Paris',
      ),
      'hotel with a pool in Paris',
    );
  });

  test('a locked type does not repeat the type word or the location', () {
    expect(
      suggestLockedTypeQuery(
        typed: 'restaurant',
        activityType: 'dining',
        location: 'Rome',
      ),
      'restaurant in Rome',
    );
    expect(
      suggestLockedTypeQuery(
        typed: 'cafe in Rome',
        activityType: 'dining',
        location: 'Rome',
      ),
      'restaurant cafe in Rome',
    );
  });
}
