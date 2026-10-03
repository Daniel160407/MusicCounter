// Firebase project used for syncing with the iOS app. apiKey and projectId come from
// Firebase console → Project settings → General → Your apps → (Web app) → SDK setup;
// googleClientId from Authentication → Sign-in method → Google → Web SDK configuration.
// Neither is a secret: access is enforced by the Firestore rules in firestore.rules.
// While they still read YOUR_…, sync stays switched off and the popup hides it.
const FIREBASE_CONFIG = {
  apiKey: 'AIzaSyA60hZz8gD8RmjKTs34UJ-aXyPyAb3ZXiE',
  projectId: 'music-counter-40273',
  googleClientId: '515308983046-7rflp469pb26caq51n0minf89if930qv.apps.googleusercontent.com',
};
