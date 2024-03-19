// -*- js-indent-level: 2 -*-
import { assign, createActor, setup, raise } from "xstate";
import { speechstate } from "speechstate";
import { createBrowserInspector } from "@statelyai/inspect";
import { _ } from "lodash";
import { KEY } from "./azure.js";

const inspector = createBrowserInspector();

const azureCredentials = {
  endpoint:
    "https://northeurope.api.cognitive.microsoft.com/sts/v1.0/issuetoken",
  key: KEY,
};

const settings = {
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
  if (cards.length === 0)
    return 0;

  if (cards[0] === 1) {
    const ace_1_tail_score = max_score_le_n(_.tail(cards), n - 1);
    const ace_10_tail_score = max_score_le_n(_.tail(cards), n - 10);
    
    if (ace_1_tail_score === undefined && ace_10_tail_score === undefined)
      return undefined;
    else if (ace_1_tail_score === undefined)
      return 10 + ace_10_tail_score;
    else if (ace_10_tail_score === undefined)
      return 1 + ace_1_tail_score;

    return _.max([1 + ace_1_tail_score, 10 + ace_10_tail_score]);
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
    
    this.dealer.draw(this.deck);

    this.player.draw(this.deck);
    this.player.draw(this.deck);
  }
}

function random_blackjack_game() {
  return new Game(random_deck(1));
}


function asr_to_event(asr_event) {
  console.log("asr_to_event()");
  console.log(asr_event);

  switch (asr_event.value[0].utterance.toLowerCase()) {
  case "hit":
    return "HIT";
  case "stand":
    return "STAND";
  }

  return "NOT_RECOGNIZED";
}

function asr_to_yes_no(asr_event) {
  switch (asr_event.value[0].utterance.toLowerCase()) {
  case "yes":
    return "YES";
  case "no":
    return "NO";
  }

  return "NOT_RECOGNIZED";
}


function speak(utterance_fn) {
  return ({ context }) => context.ssRef.send({
    type: "SPEAK",
    value: {
      utterance: utterance_fn({ game: context.game }),
    }
  });
}

const say_deal = speak(({ game }) =>
  `I have ${pronounce_one(game.dealer.cards[0])}, you have ${pronounce_two(game.player.cards)}.`
);

const player_say_drawn_card = speak(({ game }) =>
  `You drew ${pronounce_one(_.last(game.player.cards))}.`
);

const dealer_say_drawn_card = speak(({ game }) =>
  `I draw ${pronounce_one(_.last(game.dealer.cards))}.`
);

const explain_player_bust = speak(({ game }) =>
  `Your score is ${game.player.min_score()}, you are bust.`
);



const compare_scores = speak(({ game }) => {
  const player_score = game.player.max_score();
  const dealer_score = game.dealer.max_score();

  const winner = (player_score > dealer_score) ? "you" : "I";

  return `Your score is ${player_score}, my score is ${dealer_score}. ${winner} win!`;
});



const dmMachine = setup({
  actions: {
    raise_player_input: raise(({ context, event }) => ({ type: asr_to_event(event) })),
    raise_play_again_input: raise(( {context, event }) => ({ type: asr_to_yes_no(event) })),

    player_draw: ({ context }) => { context.game.player.draw(context.game.deck); },
    dealer_draw: ({ context }) => { context.game.dealer.draw(context.game.deck); },

    say_deal,

    compare_scores,

    player_say_drawn_card,
    dealer_say_drawn_card,

    explain_player_bust,

    listen: ({ context }, params) => context.ssRef.send({
      type: "LISTEN",
      value: {},
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
      on: {
        CLICK: "Deal",
      },
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
        HIT: "PlayerHit",
        STAND: "DealerPlayingIntro",
      },
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
      on: { SPEAK_COMPLETE: "AskPlayAgain" },
    },
    DealerBust: {
      entry: "explain_dealer_bust",
      on: { SPEAK_COMPLETE: "AskPlayAgain" },
    },

    CompareScores: {
      entry: "compare_scores",
      on: { SPEAK_COMPLETE: "AskPlayAgain" },
    },

    AskPlayAgain: {
      //entry: "ask_play_again",
      entry: speak(() => "Do you want to play again?"),
      on: { SPEAK_COMPLETE: "ListenPlayAgain" },
    },
    ListenPlayAgain: {
      entry: "listen",
      on: {
        RECOGNISED: { actions: "raise_play_again_input" },
        YES: "Deal",
        NO: "Done",
      },
    },

    Done: {
      always: "WaitToStart",
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
