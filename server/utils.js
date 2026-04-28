// Pick a random element from an array. Used to vary prompt phrasing so the
// same trigger doesn't always produce the identical sentence.
export const pick = (arr) => arr[Math.floor(Math.random() * arr.length)];
