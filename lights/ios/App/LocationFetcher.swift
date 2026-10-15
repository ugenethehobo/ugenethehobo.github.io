import CoreLocation

/// Gets the phone's location once (for sunrise and sunset times). Create and
/// use it on the main thread; Core Location calls back on the same thread.
final class LocationFetcher: NSObject, CLLocationManagerDelegate {
    private var manager: CLLocationManager?
    private var continuation: CheckedContinuation<CLLocation, Error>?

    func fetch() async throws -> CLLocation {
        try await withCheckedThrowingContinuation { c in
            DispatchQueue.main.async {
                self.continuation = c
                let m = CLLocationManager()
                m.delegate = self
                m.desiredAccuracy = kCLLocationAccuracyKilometer
                self.manager = m
                switch m.authorizationStatus {
                case .notDetermined:
                    m.requestWhenInUseAuthorization()
                case .denied, .restricted:
                    self.finish(.failure(LightsError(message: "Location is off for Lights. Turn it on in Settings → Privacy & Security → Location Services.")))
                default:
                    m.requestLocation()
                }
            }
        }
    }

    private func finish(_ result: Result<CLLocation, Error>) {
        continuation?.resume(with: result)
        continuation = nil
    }

    func locationManagerDidChangeAuthorization(_ manager: CLLocationManager) {
        guard continuation != nil else { return }
        switch manager.authorizationStatus {
        case .authorizedWhenInUse, .authorizedAlways: manager.requestLocation()
        case .denied, .restricted: finish(.failure(LightsError(message: "Location permission was declined.")))
        default: break
        }
    }

    func locationManager(_ manager: CLLocationManager, didUpdateLocations locations: [CLLocation]) {
        if let loc = locations.last { finish(.success(loc)) }
    }

    func locationManager(_ manager: CLLocationManager, didFailWithError error: Error) {
        finish(.failure(LightsError(message: "Couldn’t get your location: \(error.localizedDescription)")))
    }
}
