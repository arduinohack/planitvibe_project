import 'package:flutter_test/flutter_test.dart';
import 'package:planitvibe_frontend/utils/itinerary_warning.dart';

void main() {
  test('overlap and tight travel labels stay short', () {
    expect(overlapWarningText(), 'Overlaps previous');
    expect(tightTravelWarningText(40), 'Tight travel (~40 min)');
    expect(tightTravelWarningText(null), 'Tight travel');
  });

  test('warning details name the activity and the minutes', () {
    expect(
      overlapWarningDetail('Lunch'),
      'Lunch overlaps the previous activity.',
    );
    expect(
      tightTravelWarningDetail(40),
      'Travel from the previous activity takes about 40 min, and the gap is shorter.',
    );
  });
}
