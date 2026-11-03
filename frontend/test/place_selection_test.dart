import 'package:flutter_test/flutter_test.dart';
import 'package:planitvibe_frontend/screens/plan_detail_screen.dart';

void main() {
  test('selecting a result sets the Place ID on the activity', () {
    final selection = applyPlaceSelection(
      location: '',
      placeId: '  ChIJISz8NjyuEmsRFTQ9Iw7Ear8  ',
      name: 'Cafe Paris',
    );

    expect(selection.googlePlaceId, 'ChIJISz8NjyuEmsRFTQ9Iw7Ear8');
    expect(selection.location, 'Cafe Paris');
  });

  test('a filled location is replaced by the chosen place name', () {
    final selection = applyPlaceSelection(
      location: 'Harbor lunch',
      placeId: 'ChIJISz8NjyuEmsRFTQ9Iw7Ear8',
      name: 'Cafe Paris',
    );

    expect(selection.googlePlaceId, 'ChIJISz8NjyuEmsRFTQ9Iw7Ear8');
    expect(selection.location, 'Cafe Paris');
  });

  test('search starts from the location until the user changes it', () {
    expect(
      placeSearchTextFromLocation(
        location: ' Seligman, AZ ',
        search: '',
        seed: '',
      ),
      'Seligman, AZ',
    );
    expect(
      placeSearchTextFromLocation(
        location: 'Seligman, AZ',
        search: 'Seligman',
        seed: 'Seligman',
      ),
      'Seligman, AZ',
    );
    expect(
      placeSearchTextFromLocation(
        location: '',
        search: 'Seligman',
        seed: 'Seligman',
      ),
      '',
    );
    expect(
      placeSearchTextFromLocation(
        location: 'Seligman, AZ',
        search: 'Cafe',
        seed: 'Seligman',
      ),
      isNull,
    );
    expect(
      placeSearchTextFromLocation(
        location: 'Seligman, AZ',
        search: 'Seligman, AZ',
        seed: 'Seligman, AZ',
      ),
      isNull,
    );
  });

  test('a blank place name does not clear an empty location', () {
    final selection = applyPlaceSelection(
      location: '   ',
      placeId: 'ChIJISz8NjyuEmsRFTQ9Iw7Ear8',
      name: '  ',
    );

    expect(selection.googlePlaceId, 'ChIJISz8NjyuEmsRFTQ9Iw7Ear8');
    expect(selection.location, isNull);
  });
}
