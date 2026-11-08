const SENTENCES = [
  "The quiet train left the station before anyone noticed the rain.",
  "Fresh bread cools on the window sill while the kettle starts to sing.",
  "She folded the map twice and walked toward the brighter side of town.",
  "Every small habit adds up to something larger than it first appears.",
  "A good question is often worth more than a fast answer.",
  "The old bridge creaked as the trucks rolled slowly across it at dawn.",
  "We planted tomatoes in April and ate them on the porch in August.",
  "Light travels fast, but news in a small village travels even faster.",
  "He kept a notebook of strange words he heard on the bus each morning.",
  "The museum was empty except for a guard humming an old song.",
  "Clear thinking starts with writing down what you actually believe.",
  "Our neighbor's cat sleeps on the warm hood of every parked car.",
  "Pack a sweater, because the mountain wind changes without warning.",
  "The library smelled of dust, paper, and a hint of lemon polish.",
  "Practice does not make perfect, but it does make things easier.",
  "Two boats drifted past the harbor lights just after midnight.",
  "The recipe called for three eggs, a cup of flour, and some patience.",
  "Thunder rolled over the valley as the farmers hurried the cows inside.",
  "Most mistakes look obvious once you have slept on them.",
  "The kids built a fort from blankets, chairs, and a broken umbrella.",
  "A single candle can make a dark room feel surprisingly calm.",
  "The violinist tuned her strings while the audience found their seats.",
  "Keep your hands relaxed and let your eyes stay on the words ahead.",
  "Autumn leaves gathered in the corner where the wind could not reach.",
  "The coffee shop on the corner opens at six and closes when it rains.",
  "Nobody remembered who first painted the blue door at the end of the lane.",
  "Fast typing comes from rhythm, not from rushing every single key.",
  "The lighthouse keeper wrote letters he never planned to send.",
  "A bicycle bell rang twice, and the pigeons scattered into the sky.",
  "Some of the best ideas arrive while you are washing the dishes."
];

/** Join `parts` distinct random sentences, avoiding an exact repeat of `previous`. */
export function makeText(parts, previous = '') {
  for (let attempt = 0; attempt < 5; attempt++) {
    const pool = SENTENCES.slice();
    const picked = [];
    for (let i = 0; i < parts; i++) {
      picked.push(pool.splice(Math.floor(Math.random() * pool.length), 1)[0]);
    }
    const text = picked.join(' ');
    if (text !== previous) return text;
  }
  return SENTENCES[0];
}
