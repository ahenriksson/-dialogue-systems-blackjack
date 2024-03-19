// -*- js-indent-level: 2 -*-
import { assign, createActor, setup, raise } from "xstate";
import { speechstate } from "speechstate";
import { createBrowserInspector } from "@statelyai/inspect";
import { _ } from "lodash";
import { KEY, NLU_KEY } from "./azure.js";

const inspector = createBrowserInspector();

const azureLanguageCredentials = {
  endpoint: "https://dialogue2024123.cognitiveservices.azure.com/language/:analyze-conversations?api-version=2022-10-01-preview",
  key: NLU_KEY,
  deploymentName: "blackjack",
  projectName: "blackjack",
};

const azureCredentials = {
  endpoint:
    "https://northeurope.api.cognitive.microsoft.com/sts/v1.0/issuetoken",
  key: KEY,
};

const settings = {
  azureLanguageCredentials: azureLanguageCredentials,
  azureCredentials: azureCredentials,
  asrDefaultCompleteTimeout: 0,
  asrDefaultNoInputTimeout: 5000,
  locale: "en-US",
  ttsDefaultVoice: "en-US-DavisNeural",
};


// 1: ace, 2-10, 11: J, 12: Q, 13: K

const card_pronounce = {
  1:  {s: "an ace",   p: "aces"},
  2:  {s: "a two",    p: "twos"},
  3:  {s: "a three",  p: "threes"},
  4:  {s: "a four",   p: "fours"},
  5:  {s: "a five",   p: "fives"},
  6:  {s: "a six",    p: "sixes"},
  7:  {s: "a seven",  p: "sevens"},
  8:  {s: "an eight", p: "eights"},
  9:  {s: "a nine",   p: "nines"},
  10: {s: "a ten",    p: "tens"},
  11: {s: "a jack",   p: "jacks"},
  12: {s: "a queen",  p: "queens"},
  13: {s: "a king",   p: "kings"},
};

function pronounce_two(cards) {
  console.assert(cards.length === 2);
  if (cards[0] === cards[1])
    return `two ${card_pronounce[cards[0]].p}`;
  else
    return `${card_pronounce[cards[0]].s} and ${card_pronounce[cards[1]].s}`;
}

function pronounce_one(card) {
  return card_pronounce[card].s;
}

function pronounce_list(cards) {
  let out = "";
  let cards_left = undefined;

  do {
    out += pronounce_one(cards[0]);

    cards = _.tail(cards);
    cards_left = cards.length;

    if (cards_left === 1)
      out += " and ";
    else if (cards_left > 0)
      out += ", ";
  } while (cards_left > 0);

  return out;
}

const suite = _.range(1, 13+1);


class Deck {
  constructor(cards) {
    this.cards = cards;
  }

  take() {
    const card = _.head(this.cards);
    this.cards = _.tail(this.cards);
    return card;
  }
}

function random_deck(decks) {
  function repeat_array(times, array) {
    return _.range(times).flatMap(() => array);
  }

  return new Deck(_.shuffle(repeat_array(decks * 4, suite)));
}

function max_score_le_n(cards, n) {
  if (n < 0)
    return undefined;

  if (cards.length === 0)
    return 0;

  if (cards[0] === 1) {
    const ace_1_tail_score = max_score_le_n(_.tail(cards), n - 1);
    const ace_11_tail_score = max_score_le_n(_.tail(cards), n - 11);
    
    if (ace_1_tail_score === undefined && ace_11_tail_score === undefined)
      return undefined;
    else if (ace_1_tail_score === undefined)
      return 11 + ace_11_tail_score;
    else if (ace_11_tail_score === undefined)
      return 1 + ace_1_tail_score;

    return _.max([1 + ace_1_tail_score, 11 + ace_11_tail_score]);
  }

  const card_0_score = card_min_score(_.head(cards));

  if (card_0_score > n)
    return undefined;

  return card_0_score + max_score_le_n(_.tail(cards), n - card_0_score);
}

function card_min_score(card) {
  if (card > 10)
    return 10;
  else
    return card;
}

function card_score_text(card) {
  if (card === 1)
    return "either one or eleven points";
  else
    return `${card_min_score(card)} points`;
}

class Hand {
  constructor() {
    this.cards = [];
  }

  draw(deck) {
    this.cards.push(deck.take());
  }

  min_score() {
    return _.sum(this.cards.map(card_min_score));
  }

  max_score() {
    return max_score_le_n(this.cards, 21);
  }

  bust() {
    return this.min_score() > 21;
  }
}


class Game {
  constructor(deck) {
    this.deck = deck;
    this.player = new Hand();
    this.dealer = new Hand();

    this.finished = false;
    
    this.dealer.draw(this.deck);

    this.player.draw(this.deck);
    this.player.draw(this.deck);
  }
}

function random_blackjack_game() {
  return new Game(random_deck(1));
}


const common_events = new Set([
  "MY_SCORE",
  "MY_CARDS",
  "YOUR_SCORE",
  "YOUR_CARDS",

  "WHAT_IS_GOOD",
  "WHAT_IS_POOR",
  "WHAT_IS_DECENT",

  "WHAT_IS_SOFT",
  "WHAT_IS_BUST",

  "WHAT_IS_HIT",
  "WHAT_IS_STAND",

  "RULES",
]);

const play_events = new Set([
  "HIT",
  "STAND",
  "STRATEGY",
  ...common_events,
]);

const yes_no_events = new Set([
  "YES",
  "NO",
  ...common_events,
]);

function asr_to_event(asr_event) {
  event = asr_event.nluValue.topIntent;
  if (play_events.has(event))
    return event;
  else
    return "NOT_RECOGNIZED";
}

function asr_to_yes_no(asr_event) {
  event = asr_event.nluValue.topIntent;
  if (yes_no_events.has(event))
    return event;
  else
    return "NOT_RECOGNIZED";
}


function speak(utterance_fn) {
  return ({ context }) => context.ssRef.send({
    type: "SPEAK",
    value: {
      utterance: utterance_fn({ context, game: context.game }),
    }
  });
}


function player_score_text(game) {
  const score = game.player.max_score();

  if (game.finished)
    return `your score was ${score}`;
  else if (game.player.min_score() < score)
    return `you have a soft ${score}`;
  else
    return `your score is ${score}`;
}

const say_deal = speak(({ context, game }) => {
  let out = `I'll deal the cards. I drew ${pronounce_one(game.dealer.cards[0])}, you got ${pronounce_two(game.player.cards)}. `;
  if (context.explaining)
    out += player_score_text(game);
  return out;
});

function maybe_explain_card(context, card) {
  return context.explaining ? `, that's worth ${card_score_text(card)}` : "";
}

const player_say_drawn_card = speak(({ context, game }) => {
  const card = _.last(game.player.cards);
  return `You drew ${pronounce_one(card)}` + maybe_explain_card(context, card);
});

const dealer_say_drawn_card = speak(({ context, game }) => {
  const card = _.last(game.dealer.cards);
  return `I draw ${pronounce_one(card)}` + maybe_explain_card(context, card);
});

const say_player_score = speak(({ game }) => {
  return player_score_text(game);
});

const say_player_cards = speak(({ game }) => 
  //`You have ${pronounce_list(game.player.cards)}`
  `You ${game.finished ? "had" : "have"} ${pronounce_list(game.player.cards)}`
);

const say_dealer_score = speak(({ game }) => 
  `My score ${game.finished ? "was" : "is"} ${game.dealer.max_score()}`
);

const say_dealer_cards = speak(({ game }) =>
  `I ${game.finished ? "had" : "have"} ${pronounce_list(game.dealer.cards)}`
);


const say_strategy = speak(({ game }) => {
  const dealer_card = game.dealer.cards[0];

  if (dealer_card === 1 || dealer_card >= 7) {
    return "I have a good card, so I suggest you try for a score of 17 or higher";
  } else if (dealer_card >= 4) {
    return "I have a poor card, so I suggest you try for a score of 12 or higher";
  } else { // 2 or 3
    return "I have a decent card, so I suggest you try for a score of 13 or higher";
  }
});


const explain_player_bust = speak(({ game }) =>
  `Your score is ${game.player.min_score()}, you are bust. I win.`
);

const explain_dealer_bust = speak(({ game }) =>
  `My score is ${game.dealer.min_score()}, I am bust. You win!`
);


const compare_scores = speak(({ game }) => {
  const player_score = game.player.max_score();
  const dealer_score = game.dealer.max_score();

  const winner = (player_score > dealer_score) ? "you" : "I";

  return `Your score is ${player_score}, my score is ${dealer_score}. ${winner} win!`;
});



const dmMachine = setup({
  actions: {
    set_explaining_mode: ({ context }) => { context.explaining = true; },

    raise_rules_input: raise(({ context, event }) => ({ type: asr_to_yes_no(event) })),
    raise_player_input: raise(({ context, event }) => ({ type: asr_to_event(event) })),
    raise_play_again_input: raise(( {context, event }) => ({ type: asr_to_yes_no(event) })),

    say_rules: speak(() => 
      "I'll deal you cards one at a time, "
        + "the goal is to get as close to 21 as possible, but if you go above it, you lose. "
        + "<emphasis level='strong'>You</emphasis> can stop at any time, but when it's <emphasis level='strong'>>my</emphasis> turn, I have to continue until my score is 17 or above. "
        +  "Twos to tens are worth that many points, jacks, queens and kings are worth ten points, and aces are worth either one or 11 points. "
        + "We'll figure the rest out as we go!"
    ),


    player_draw: ({ context }) => { context.game.player.draw(context.game.deck); },
    dealer_draw: ({ context }) => { context.game.dealer.draw(context.game.deck); },

    say_deal,

    compare_scores,

    player_say_drawn_card,
    dealer_say_drawn_card,

    say_player_score,
    say_player_cards,

    say_dealer_score,
    say_dealer_cards,

    say_strategy,

    explain_player_bust,
    explain_dealer_bust,

    finish_game: ({ context }) => { context.game.finished = true; },

    listen: ({ context }, params) => context.ssRef.send({
      type: "LISTEN",
      value: { nlu: true },
    }),
  },
  guards: {
    player_bust: ({ context }) => context.game.player.bust(),
    dealer_bust: ({ context }) => context.game.dealer.bust(),

    dealer_score_ge_17: ({ context }) => context.game.dealer.max_score() >= 17,
  }
}).createMachine({
  context: {
  },
  id: "DM",
  initial: "Prepare",
  states: {
    Prepare: {
      entry: [
        assign({
          ssRef: ({ spawn }) => spawn(speechstate, { input: settings }),
        }),
        ({ context }) => context.ssRef.send({ type: "PREPARE" }),
      ],
      on: { ASRTTS_READY: "WaitToStart" },
    },
    WaitToStart: {
      entry: assign({ explaining: false }),
      on: {
        CLICK: "Game",
      },
    },
    Game: {
      initial: "Intro",
      onDone: "WaitToStart",
      states: {
        Intro: {
          entry: speak(() => "Let's play blackjack! Do you know the rules?"),
          on: { SPEAK_COMPLETE: "RulesListen" },
        },
        RulesListen: {
          entry: "listen",
          on: {
            RECOGNISED: { actions: "raise_rules_input" },
            YES: "Deal",
            NO: "Rules",
          },
        },
        Rules: {
          entry: [
            "set_explaining_mode",
            "say_rules",
          ],
          on: { SPEAK_COMPLETE: "Deal" },
        },
        Deal: {
          entry: [
            assign({ game: () => random_blackjack_game() }),
            "say_deal",
          ],
          on: {
            SPEAK_COMPLETE: "PlayerPlaying",
          },
        },
        PlayerPlaying: {
          entry: [
            { type: "listen" },
          ],
          on: {
            RECOGNISED: { actions: [ "raise_player_input" ] },
            ASR_NOINPUT: "ExplainPlayingInput",

            HIT: "PlayerHit",
            STAND: "DealerPlayingIntro",

            STRATEGY: {
              actions: "say_strategy",
              target: "DealerSpeaking",
            },

            NOT_RECOGNIZED: "ExplainPlayingInput",
          },
        },
        ExplainPlayingInput: {
          entry: speak(({context}) => "Do you want to hit or stand?" + (context.explaining ? " Hit if you want another card, stand if you're done" : "")),
          on: { SPEAK_COMPLETE: "PlayerPlaying" }
        },
        DealerSpeaking: {
          on: { SPEAK_COMPLETE: "PlayerPlaying" },
        },
        PlayerHit: {
          entry: [
            "player_draw",
            "player_say_drawn_card",
          ],
          on: {
            SPEAK_COMPLETE: [
              {
                guard: "player_bust",
                target: "PlayerBust",
              },
              {
                target: "PlayerPlaying",
              },
            ],
          },
        },

        DealerPlayingIntro: {
          entry: speak(({ game }) => `My turn. I had ${pronounce_one(game.dealer.cards[0])}`),
          on: {
            SPEAK_COMPLETE: "DealerPlaying",
          },
        },
        DealerPlaying: {
          entry: [
            "dealer_draw",
            "dealer_say_drawn_card",
          ],
          on: {
            SPEAK_COMPLETE: [
              {
                guard: "dealer_bust",
                target: "DealerBust",
              },
              {
                guard: "dealer_score_ge_17",
                target: "CompareScores",
              },
              {
                target: "DealerPlaying",
                reenter: true,
              },
            ],
          }
        },

        PlayerBust: {
          entry: "explain_player_bust",
          on: { SPEAK_COMPLETE: "FinishGame" },
        },
        DealerBust: {
          entry: "explain_dealer_bust",
          on: { SPEAK_COMPLETE: "FinishGame" },
        },

        CompareScores: {
          entry: "compare_scores",
          on: { SPEAK_COMPLETE: "FinishGame" },
        },

        FinishGame: {
          entry: "finish_game",
          always: "AskPlayAgain",
        },

        AskPlayAgain: {
          initial: "Ask",
          states: {
            Ask: {
              entry: speak(() => "Do you want to play again?"),
              on: { SPEAK_COMPLETE: "Listen" },
            },
            Listen: {
              entry: "listen",
              on: {
                RECOGNISED: { actions: "raise_play_again_input" },
                //ASR_NOINPUT: "Ask",

                YES: "#DM.Game.Deal",
                NO: "#DM.Game.Done",

                NOT_RECOGNIZED: "Ask",
              },
            },
          },
        },

        Done: {
          type: "final",
        },
        Hist: {
          type: "history",
        },
      },
      on: {
        ASR_NOINPUT: {
          actions: speak(() => "I didn't hear you"),
          target: "DealerSpeaking",
        },

        // handle common grammar entries

        MY_SCORE: {
          actions: "say_player_score",
          target: "DealerSpeaking",
        },
        MY_CARDS: {
          actions: "say_player_cards",
          target: "DealerSpeaking",
        },
        YOUR_SCORE: {
          actions: "say_dealer_score",
          target: "DealerSpeaking",
        },
        YOUR_CARDS: {
          actions: "say_dealer_cards",
          target: "DealerSpeaking",
        },

        WHAT_IS_GOOD: {
          actions: speak(() => "Seven or higher is a good dealer card"),
          target: "DealerSpeaking",
        },
        WHAT_IS_POOR: {
          actions: speak(() => "Poor dealer cards are 4, 5 and 6"),
          target: "DealerSpeaking",
        },
        WHAT_IS_DECENT: {
          actions: speak(() => "2 and 3 are decent dealer cards"),
          target: "DealerSpeaking",
        },

        WHAT_IS_SOFT: {
          actions: speak(() => "A soft hand is when you have an ace, which can either count as one or eleven, your choice"),
          target: "DealerSpeaking",
        },
        WHAT_IS_BUST: {
          actions: speak(() => "That's just something we say when your score is above 21"),
          target: "DealerSpeaking",
        },

        WHAT_IS_HIT: {
          actions: speak(() => "Hit means that you want another card"),
          target: "DealerSpeaking",
        },
        WHAT_IS_STAND: {
          actions: speak(() => "Stand means that you want to stop"),
          target: "DealerSpeaking",
        },

        RULES: {
          actions: "say_rules",
          target: "DealerSpeaking",
        },
      },
    },
    DealerSpeaking: {
      on: {
        SPEAK_COMPLETE: "Game.Hist",
      }
    },
  },
});

const dmActor = createActor(dmMachine, {
  inspect: inspector.inspect,
}).start();

dmActor.subscribe((state) => {
  console.log(state.context);
});

export function setupButton(element) {
  element.addEventListener("click", () => {
    dmActor.send({ type: "CLICK" });
  });
  dmActor.getSnapshot().context.ssRef.subscribe((snapshot) => {
    element.innerHTML = `${snapshot.value.AsrTtsManager.Ready}`;
  });
}
